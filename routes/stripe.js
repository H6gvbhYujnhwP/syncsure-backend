// routes/stripe.js
import express from "express";
import Stripe from "stripe";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { sendWelcomeEmail, sendPaymentConfirmationEmail } from "../services/email.js";

// Stripe needs the raw body; index.js already mounts `stripeRaw` before json()
export const stripeRaw = express.raw({ type: "application/json" });
const router = express.Router();

// CRITICAL: Prevent caching of sensitive subscription/license data
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Vary': 'Authorization' // Prevent sharing across users/CDN
  });
  next();
});

// ---- Helpers ----

// simple license key generator (deterministic length, uppercase)
function generateLicenseKey() {
  const buf = crypto.randomBytes(16).toString("hex").toUpperCase(); // 32 hex chars
  // group like ABCD-EFGH-...
  return buf.match(/.{1,4}/g).join("-");
}

async function upsertAccountByCustomer({ email, stripeCustomerId }) {
  const q = `
    insert into accounts (email, stripe_customer_id, role)
    values ($1, $2, 'user')
    on conflict (email) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, accounts.stripe_customer_id)
    returning id, email
  `;
  const { rows } = await pool.query(q, [email, stripeCustomerId]);
  return rows[0]; // { id, email }
}

async function upsertSubscription({
  accountId,
  stripeSubscriptionId,
  blocks,
  status,
  currentPeriodEnd
}) {
  const q = `
    insert into subscriptions (account_id, stripe_subscription_id, blocks, status, current_period_end)
    values ($1, $2, $3, $4, to_timestamp($5))
    on conflict (stripe_subscription_id) do update set
      account_id = excluded.account_id,
      blocks = excluded.blocks,
      status = excluded.status,
      current_period_end = excluded.current_period_end
    returning id
  `;
  const { rows } = await pool.query(q, [
    accountId,
    stripeSubscriptionId,
    blocks,
    status,
    currentPeriodEnd ? Math.floor(currentPeriodEnd) : null
  ]);
  return rows[0];
}

async function ensureLicenseForAccount({ accountId, blocks }) {
  // decide device allowance; tweak if you want different mapping
  const maxDevices = Math.max(1, Number(blocks || 1)) * 5;

  // if a license already exists, just make sure max_devices reflects blocks
  const existing = await pool.query(
    `select id, license_key, max_devices from licenses where account_id=$1 order by created_at asc limit 1`,
    [accountId]
  );
  if (existing.rows.length > 0) {
    const lic = existing.rows[0];
    if (lic.max_devices !== maxDevices) {
      await pool.query(
        `update licenses set max_devices=$1, updated_at=now() where id=$2`,
        [maxDevices, lic.id]
      );
    }
    return lic; // { id, license_key, max_devices }
  }

  const licenseKey = generateLicenseKey();
  const insert = await pool.query(
    `insert into licenses (account_id, license_key, max_devices)
     values ($1,$2,$3)
     returning id, license_key, max_devices`,
    [accountId, licenseKey, maxDevices]
  );
  return insert.rows[0];
}

async function writeAudit({ actor, accountId, licenseId, event, context = {} }) {
  await pool.query(
    `insert into audit_log (actor, account_id, license_id, event, context)
     values ($1,$2,$3,$4,$5)`,
    [actor, accountId || null, licenseId || null, event, context]
  );
}

async function triggerBuildForLicense(licenseId, accountId) {
  // Create a build record to trigger the worker
  const tag = `license-${licenseId}-${Date.now()}`;
  
  const buildQuery = `
    insert into builds (license_id, account_id, status, tag)
    values ($1, $2, 'queued', $3)
    returning id, tag
  `;
  
  const { rows } = await pool.query(buildQuery, [licenseId, accountId, tag]);
  const build = rows[0];
  
  console.log(`🏗️ Build queued for license ${licenseId}: ${build.tag}`);
  return build;
}

// Extract “blocks” from a Stripe subscription object
function extractBlocks(stripeSubscription) {
  // Priority: item.quantity → item.metadata.blocks → subscription.metadata.blocks → 1
  const items = stripeSubscription?.items?.data || [];
  let qty = 0;
  if (items[0]?.quantity) qty = Number(items[0].quantity);
  let blocks =
    qty ||
    Number(items[0]?.metadata?.blocks || 0) ||
    Number(stripeSubscription?.metadata?.blocks || 0) ||
    1;
  return Math.max(1, blocks);
}

// ---- Webhook handler ----

router.post("/", async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  if (!secret || !stripeKey) {
    // Keep deploys safe if not configured yet
    return res.status(204).send();
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error("[stripe] signature verify failed:", e.message);
    return res.status(400).json({ ok: false, error: "invalid signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // Session-level context (email + subscription id) - DO NOT CREATE LICENSE YET
        const session = event.data.object;
        const email =
          session?.customer_details?.email ||
          session?.customer_email ||
          session?.metadata?.email ||
          null;
        const stripeCustomerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id || null;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id || null;

        if (!email || !stripeCustomerId) {
          await writeAudit({
            actor: "stripe",
            event: "CHECKOUT_COMPLETED_MISSING_FIELDS",
            context: { email, stripeCustomerId, subscriptionId }
          });
          break;
        }

        // Only create account, do NOT create license until payment is confirmed
        const account = await upsertAccountByCustomer({ email, stripeCustomerId });

        await writeAudit({
          actor: "stripe",
          accountId: account.id,
          event: "CHECKOUT_COMPLETED_ACCOUNT_CREATED",
          context: { subscriptionId, email }
        });

        break;
      }

      case "invoice.payment_succeeded": {
        // This is the event that confirms payment was actually successful
        const invoice = event.data.object;
        const stripeCustomerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id || null;
        const subscriptionId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id || null;

        if (!stripeCustomerId || !subscriptionId) {
          await writeAudit({
            actor: "stripe",
            event: "PAYMENT_SUCCEEDED_MISSING_FIELDS",
            context: { stripeCustomerId, subscriptionId }
          });
          break;
        }

        // Get customer email
        let email = null;
        try {
          const customer = await stripe.customers.retrieve(stripeCustomerId);
          email = customer?.email || null;
        } catch (e) {
          console.error("Failed to retrieve customer:", e.message);
        }

        if (!email) {
          await writeAudit({
            actor: "stripe",
            event: "PAYMENT_SUCCEEDED_NO_EMAIL",
            context: { stripeCustomerId, subscriptionId }
          });
          break;
        }

        const account = await upsertAccountByCustomer({ email, stripeCustomerId });

        // Fetch the subscription to derive blocks & period end
        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items"] });
        const blocks = extractBlocks(sub);
        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end; // unix ts

        await upsertSubscription({
          accountId: account.id,
          stripeSubscriptionId: sub.id,
          blocks,
          status,
          currentPeriodEnd
        });

        // NOW create license after payment confirmation
        const lic = await ensureLicenseForAccount({ accountId: account.id, blocks });

        // Trigger build for new license
        await triggerBuildForLicense(lic.id, account.id);

        // Send welcome email with license information
        try {
          await sendWelcomeEmail({
            to: email,
            customerName: account.name || email.split('@')[0],
            licenseKey: lic.license_key,
            downloadUrl: `${process.env.FRONTEND_ORIGIN || 'https://syncsure.cloud'}/dashboard`,
            maxDevices: lic.max_devices
          });
          
          console.log(`[email] Welcome email sent to ${email} for license ${lic.license_key}`);
        } catch (emailError) {
          console.error(`[email] Failed to send welcome email to ${email}:`, emailError.message);
          // Don't fail the webhook if email fails
        }

        // Send payment confirmation email
        try {
          const invoiceAmount = (invoice.amount_paid / 100).toFixed(2);
          const nextBillingDate = new Date(sub.current_period_end * 1000).toLocaleDateString();
          
          await sendPaymentConfirmationEmail({
            to: email,
            customerName: account.name || email.split('@')[0],
            amount: invoiceAmount,
            invoiceId: invoice.id,
            nextBilling: nextBillingDate
          });
          
          console.log(`[email] Payment confirmation sent to ${email} for invoice ${invoice.id}`);
        } catch (emailError) {
          console.error(`[email] Failed to send payment confirmation to ${email}:`, emailError.message);
          // Don't fail the webhook if email fails
        }

        await writeAudit({
          actor: "stripe",
          accountId: account.id,
          licenseId: lic.id,
          event: "PAYMENT_SUCCEEDED_LICENSE_CREATED",
          context: { subscriptionId: sub.id, blocks, status, invoiceId: invoice.id, emailsSent: true }
        });

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Only update subscription data, do NOT create license until payment confirmed
        const sub = event.data.object; // full stripe subscription
        const stripeCustomerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;

        // Best effort to get email
        let email = null;
        try {
          const cust =
            stripeCustomerId && (await stripe.customers.retrieve(stripeCustomerId));
          email = cust?.email || null;
        } catch {
          // ignore
        }

        const account = await upsertAccountByCustomer({ email: email || "unknown@unknown", stripeCustomerId });

        const blocks = extractBlocks(sub);
        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end;

        await upsertSubscription({
          accountId: account.id,
          stripeSubscriptionId: sub.id,
          blocks,
          status,
          currentPeriodEnd
        });

        // Do NOT create license here - wait for payment confirmation
        await writeAudit({
          actor: "stripe",
          accountId: account.id,
          event: event.type.toUpperCase() + "_NO_LICENSE",
          context: { subscriptionId: sub.id, blocks, status }
        });

        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const stripeCustomerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;

        // Mark subscription canceled
        const q = `update subscriptions set status='canceled', current_period_end=to_timestamp($1)
                   where stripe_subscription_id=$2`;
        await pool.query(q, [sub.current_period_end || sub.canceled_at || null, sub.id]);

        // Optional: also reduce license max_devices to 0 or keep at last value
        // await pool.query(`update licenses set max_devices=0, updated_at=now()
        //                   where account_id in (select id from accounts where stripe_customer_id=$1)`, [stripeCustomerId]);

        // Audit
        const accId = await pool
          .query(`select id from accounts where stripe_customer_id=$1 limit 1`, [stripeCustomerId])
          .then((r) => r.rows[0]?.id || null);

        await writeAudit({
          actor: "stripe",
          accountId: accId,
          event: "CUSTOMER_SUBSCRIPTION_DELETED",
          context: { subscriptionId: sub.id }
        });

        break;
      }

      default:
        // Unhandled event types are fine; acknowledge
        // console.log("[stripe] unhandled:", event.type);
        break;
    }

    return res.json({ ok: true, type: event.type });
  } catch (e) {
    console.error("[stripe] handler error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Create Stripe Checkout Session
router.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, priceId, successUrl, cancelUrl } = req.body;

    if (!email || !priceId) {
      return res.status(400).json({ error: "Email and priceId are required" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Create or retrieve customer
    let customer;
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: email,
        metadata: {
          source: 'syncsure_dashboard'
        }
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl || `${process.env.FRONTEND_ORIGIN}/dashboard?success=true`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_ORIGIN}/dashboard?canceled=true`,
      metadata: {
        customer_email: email
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get customer subscription data
router.get("/subscription", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    // In a real app, you'd verify the JWT token here
    // For now, we'll extract email from the request or token
    const email = req.query.email || req.user?.email;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // 1) Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    const customer = customers.data[0];
    if (!customer) {
      return res.json({
        active: false,
        licenseCount: 0,
        deviceCount: 0,
        customerId: null,
        subscriptionId: null,
        nextBilling: null,
        invoices: []
      });
    }

    // 2) List ACTIVE subscriptions only
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      expand: ['data.items.data.price']
    });

    if (subscriptions.data.length === 0) {
      return res.json({
        active: false,
        licenseCount: 0,
        deviceCount: 0,
        customerId: customer.id,
        subscriptionId: null,
        nextBilling: null,
        invoices: []
      });
    }

    // 2.5) CRITICAL: Check for successful payments - subscription can be 'active' but have no payments
    const paidInvoices = await stripe.invoices.list({
      customer: customer.id,
      status: 'paid',
      limit: 100
    });

    // If no paid invoices, customer has no valid licenses regardless of subscription status
    if (paidInvoices.data.length === 0) {
      return res.json({
        active: false,
        licenseCount: 0,
        deviceCount: 0,
        customerId: customer.id,
        subscriptionId: subscriptions.data[0]?.id ?? null,
        nextBilling: null,
        invoices: []
      });
    }

    // 3) Sum quantities (seats) from Stripe subscriptions - but only if payments exist
    const licenseCount = subscriptions.data.reduce((sum, sub) => {
      const qty = sub.items.data.reduce((s, item) => s + (item.quantity ?? 0), 0);
      return sum + qty;
    }, 0);

    const nextBilling = subscriptions.data[0]?.current_period_end
      ? new Date(subscriptions.data[0].current_period_end * 1000).toLocaleDateString()
      : null;

    // Get recent invoices (use the paid invoices we already fetched)
    const invoices = paidInvoices;

    // Get device count from database (this is fine to get from DB)
    const deviceCount = 0; // TODO: Implement device counting from heartbeats

    const subscriptionData = {
      active: licenseCount > 0,
      licenseCount: licenseCount, // Now comes from Stripe, not DB
      deviceCount: deviceCount,
      customerId: customer.id,
      subscriptionId: subscriptions.data[0]?.id ?? null,
      nextBilling: nextBilling,
      invoices: invoices.data.map(invoice => ({
        id: invoice.id,
        description: invoice.lines.data[0]?.description || 'SyncSure Monitor',
        amount: (invoice.amount_paid / 100).toFixed(2),
        date: new Date(invoice.created * 1000).toLocaleDateString(),
        status: invoice.status === 'paid' ? 'Paid' : 'Pending'
      }))
    };

    res.json(subscriptionData);
  } catch (error) {
    console.error('Error fetching subscription data:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

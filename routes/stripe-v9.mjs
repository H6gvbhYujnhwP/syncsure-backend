/**
 * SyncSure V9 Stripe Routes - ES6 Module Version
 * Single-license, quantity-based system
 */

import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Prevent caching of sensitive data
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Vary': 'Authorization'
  });
  next();
});

/**
 * Map quantity to pricing tier
 */
function mapTier(quantity) {
  if (quantity <= 50) {
    return { tier: 'starter', price: 1.99 };
  } else if (quantity <= 500) {
    return { tier: 'business', price: 1.49 };
  } else {
    return { tier: 'enterprise', price: 0.99 };
  }
}

/**
 * Ensure single license per account
 */
async function ensureSingleLicense(accountId, licenseData) {
  try {
    const existingLicense = await pool.query(
      'SELECT * FROM licenses WHERE account_id = $1',
      [accountId]
    );
    
    if (existingLicense.rows.length > 0) {
      // Update existing license
      const license = existingLicense.rows[0];
      await pool.query(`
        UPDATE licenses 
        SET 
          device_count = $1,
          pricing_tier = $2,
          price_per_device = $3,
          status = $4
        WHERE id = $5
      `, [
        licenseData.device_count,
        licenseData.pricing_tier,
        licenseData.price_per_device,
        licenseData.status || 'active',
        license.id
      ]);
      
      return license;
    } else {
      // Create new license
      const result = await pool.query(`
        INSERT INTO licenses (
          account_id, license_key, device_count, pricing_tier, 
          price_per_device, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
      `, [
        accountId,
        licenseData.license_key || `SYNC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        licenseData.device_count,
        licenseData.pricing_tier,
        licenseData.price_per_device,
        licenseData.status || 'active'
      ]);
      
      return result.rows[0];
    }
  } catch (error) {
    console.error('Error ensuring single license:', error);
    throw error;
  }
}

/**
 * Upsert account from Stripe customer
 */
async function upsertAccount(customer) {
  try {
    const existingAccount = await pool.query(
      'SELECT * FROM accounts WHERE stripe_customer_id = $1 OR email = $2',
      [customer.id, customer.email]
    );
    
    if (existingAccount.rows.length > 0) {
      const account = existingAccount.rows[0];
      await pool.query(`
        UPDATE accounts 
        SET stripe_customer_id = $1, email = $2, name = $3
        WHERE id = $4
      `, [customer.id, customer.email, customer.name || customer.email, account.id]);
      
      return account.id;
    } else {
      const result = await pool.query(`
        INSERT INTO accounts (stripe_customer_id, email, name, created_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id
      `, [customer.id, customer.email, customer.name || customer.email]);
      
      return result.rows[0].id;
    }
  } catch (error) {
    console.error('Error upserting account:', error);
    throw error;
  }
}

/**
 * Upsert subscription
 */
async function upsertSubscription(accountId, subscriptionData) {
  try {
    const existingSubscription = await pool.query(
      'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1 OR account_id = $2',
      [subscriptionData.stripe_subscription_id, accountId]
    );
    
    if (existingSubscription.rows.length > 0) {
      const subscription = existingSubscription.rows[0];
      await pool.query(`
        UPDATE subscriptions 
        SET 
          stripe_subscription_id = $1,
          status = $2,
          device_quantity = $3,
          current_period_end = $4
        WHERE id = $5
      `, [
        subscriptionData.stripe_subscription_id,
        subscriptionData.status,
        subscriptionData.device_quantity,
        subscriptionData.current_period_end,
        subscription.id
      ]);
      
      return subscription.id;
    } else {
      const result = await pool.query(`
        INSERT INTO subscriptions (
          account_id, stripe_subscription_id, status, device_quantity, 
          current_period_end, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING id
      `, [
        accountId,
        subscriptionData.stripe_subscription_id,
        subscriptionData.status,
        subscriptionData.device_quantity,
        subscriptionData.current_period_end
      ]);
      
      return result.rows[0].id;
    }
  } catch (error) {
    console.error('Error upserting subscription:', error);
    throw error;
  }
}

/**
 * Process Stripe subscription (main webhook logic)
 */
async function processStripeSubscription(subscription, eventType, stripeEventId) {
  try {
    console.log(`[V9] Processing subscription ${subscription.id} for event ${eventType}`);
    
    const customer = await stripe.customers.retrieve(subscription.customer);
    const quantity = subscription.items.data[0]?.quantity || 1;
    const { tier, price } = mapTier(quantity);
    
    console.log(`[V9] Customer: ${customer.email}, Quantity: ${quantity}, Tier: ${tier}`);
    
    // Upsert account
    const accountId = await upsertAccount(customer);
    
    // Upsert subscription
    await upsertSubscription(accountId, {
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      device_quantity: quantity,
      current_period_end: new Date(subscription.current_period_end * 1000)
    });
    
    // Handle cancellation
    if (subscription.status === 'canceled') {
      const now = new Date();
      const periodEnd = new Date(subscription.current_period_end * 1000);
      
      if (now > periodEnd) {
        await ensureSingleLicense(accountId, {
          device_count: 0,
          pricing_tier: tier,
          price_per_device: price,
          status: 'canceled'
        });
        
        console.log(`[V9] License canceled for account ${accountId}`);
        return;
      }
    }
    
    // Mirror subscription to single license
    const license = await ensureSingleLicense(accountId, {
      device_count: quantity,
      pricing_tier: tier,
      price_per_device: price,
      status: 'active'
    });
    
    console.log(`[V9] License mirrored: ${license.license_key}, devices: ${quantity}, tier: ${tier}`);
    
    console.log(`[V9] Successfully processed subscription ${subscription.id}`);
    
  } catch (error) {
    console.error(`[V9] Error processing subscription ${subscription.id}:`, error);
    throw error;
  }
}

/**
 * Check if webhook event was already processed (idempotency)
 */
async function isEventProcessed(stripeEventId) {
  try {
    const result = await pool.query(
      'SELECT id FROM webhook_events WHERE stripe_event_id = $1',
      [stripeEventId]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error checking event processing:', error);
    return false;
  }
}

/**
 * Mark webhook event as processed
 */
async function markEventProcessed(stripeEventId, eventType, accountId = null) {
  try {
    await pool.query(`
      INSERT INTO webhook_events (stripe_event_id, event_type, account_id, processed_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (stripe_event_id) DO NOTHING
    `, [stripeEventId, eventType, accountId]);
  } catch (error) {
    console.error('Error marking event as processed:', error);
  }
}

// V9 Stripe webhook endpoint
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log(`[V9] Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[V9] Received webhook: ${event.type} (${event.id})`);

  // Check if event was already processed (idempotency)
  if (await isEventProcessed(event.id)) {
    console.log(`[V9] Event ${event.id} already processed, skipping`);
    return res.json({received: true, status: 'already_processed'});
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('[V9] Checkout session completed:', session.id);
        
        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await processStripeSubscription(subscription, event.type, event.id);
        }
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        await processStripeSubscription(subscription, event.type, event.id);
        break;

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        await processStripeSubscription(deletedSubscription, event.type, event.id);
        break;

      case 'invoice.paid':
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          await processStripeSubscription(subscription, event.type, event.id);
        }
        break;

      default:
        console.log(`[V9] Unhandled event type ${event.type}`);
    }

    await markEventProcessed(event.id, event.type);
    res.json({received: true, status: 'processed'});

  } catch (error) {
    console.error(`[V9] Error processing webhook ${event.type}:`, error);
    res.status(500).json({
      received: true, 
      status: 'error',
      error: error.message
    });
  }
});

// Sync specific customer by email
router.post('/sync-customer', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    console.log(`[V9] Syncing customer: ${email}`);

    // Find customer in Stripe
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      console.log(`[V9] Customer not found in Stripe: ${email}`);
      return res.status(404).json({
        success: false,
        error: 'Customer not found in Stripe'
      });
    }

    const customer = customers.data[0];
    console.log(`[V9] Customer found: ${customer.email} (${customer.id})`);

    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all'
    });

    console.log(`[V9] Found ${subscriptions.data.length} subscriptions`);

    const activeSubscription = subscriptions.data.find(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );

    if (!activeSubscription) {
      console.log(`[V9] No active subscription found for ${email}`);
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
      });
    }

    console.log(`[V9] Active subscription: ${activeSubscription.id} (${activeSubscription.status})`);

    // Process the subscription (same logic as webhook)
    await processStripeSubscription(activeSubscription, 'manual_sync', `manual_${Date.now()}`);

    console.log(`[V9] Successfully synced customer: ${email}`);

    res.json({
      success: true,
      message: 'Customer synced successfully',
      customer: {
        email: customer.email,
        subscriptionId: activeSubscription.id,
        status: activeSubscription.status,
        quantity: activeSubscription.items.data[0]?.quantity || 1
      }
    });

  } catch (error) {
    console.error('[V9] Customer sync error:', error.message);
    console.error('[V9] Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to sync customer',
      details: error.message
    });
  }
});

export default router;


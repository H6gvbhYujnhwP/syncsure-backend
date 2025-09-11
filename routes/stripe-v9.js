import express from 'express';
import Stripe from 'stripe';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// V9 Pricing Tiers Configuration
const PRICING_TIERS = {
  starter: { min: 1, max: 50, price: 1.99, name: 'Starter' },
  business: { min: 51, max: 500, price: 1.49, name: 'Business' },
  enterprise: { min: 501, max: Infinity, price: 0.99, name: 'Enterprise' }
};

// Helper function to determine pricing tier
function getPricingTier(quantity) {
  if (quantity <= 50) return 'starter';
  if (quantity <= 500) return 'business';
  return 'enterprise';
}

// Helper function to get tier info
function getTierInfo(quantity) {
  const tier = getPricingTier(quantity);
  return {
    tier,
    ...PRICING_TIERS[tier],
    quantity,
    monthlyTotal: quantity * PRICING_TIERS[tier].price
  };
}

// Get customer subscription data
router.get('/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    // Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.json({
        hasSubscription: false,
        customer: null,
        subscription: null,
        tierInfo: null
      });
    }

    const customer = customers.data[0];
    
    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return res.json({
        hasSubscription: false,
        customer: customer,
        subscription: null,
        tierInfo: null
      });
    }

    const subscription = subscriptions.data[0];
    const quantity = subscription.items.data[0].quantity;
    const tierInfo = getTierInfo(quantity);

    res.json({
      hasSubscription: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        created: customer.created
      },
      subscription: {
        id: subscription.id,
        status: subscription.status,
        quantity: quantity,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        cancel_at_period_end: subscription.cancel_at_period_end
      },
      tierInfo: tierInfo
    });

  } catch (error) {
    console.error('Error fetching customer data:', error);
    res.status(500).json({ error: 'Failed to fetch customer data' });
  }
});

// Create Stripe Checkout session
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { email, quantity, successUrl, cancelUrl } = req.body;

    if (!email || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'Invalid email or quantity' });
    }

    const tierInfo = getTierInfo(quantity);

    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'SyncSure Monitor',
            description: `${tierInfo.name} Plan - ${quantity} devices`
          },
          unit_amount: Math.round(tierInfo.price * 100), // Convert to pence
          recurring: {
            interval: 'month'
          }
        },
        quantity: quantity
      }],
      mode: 'subscription',
      success_url: successUrl || `${process.env.FRONTEND_ORIGIN}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_ORIGIN}/license-management`,
      metadata: {
        email: email,
        quantity: quantity.toString(),
        tier: tierInfo.tier
      }
    });

    res.json({ sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Update subscription quantity
router.post('/update-subscription', async (req, res) => {
  try {
    const { email, newQuantity } = req.body;

    if (!email || !newQuantity || newQuantity < 1) {
      return res.status(400).json({ error: 'Invalid email or quantity' });
    }

    // Find customer
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customers.data[0];

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const subscription = subscriptions.data[0];
    const subscriptionItem = subscription.items.data[0];

    // Update subscription quantity
    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      items: [{
        id: subscriptionItem.id,
        quantity: newQuantity
      }],
      proration_behavior: 'always_invoice'
    });

    const tierInfo = getTierInfo(newQuantity);

    res.json({
      success: true,
      subscription: {
        id: updatedSubscription.id,
        quantity: newQuantity,
        status: updatedSubscription.status
      },
      tierInfo: tierInfo
    });

  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// Cancel subscription
router.post('/cancel-subscription', async (req, res) => {
  try {
    const { email, cancelAtPeriodEnd = true } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find customer
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customers.data[0];

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const subscription = subscriptions.data[0];

    let updatedSubscription;
    if (cancelAtPeriodEnd) {
      // Cancel at period end
      updatedSubscription = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true
      });
    } else {
      // Cancel immediately
      updatedSubscription = await stripe.subscriptions.cancel(subscription.id);
    }

    res.json({
      success: true,
      subscription: {
        id: updatedSubscription.id,
        status: updatedSubscription.status,
        cancel_at_period_end: updatedSubscription.cancel_at_period_end,
        canceled_at: updatedSubscription.canceled_at
      }
    });

  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Create customer portal session
router.post('/create-portal-session', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find customer
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customers.data[0];

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl || `${process.env.FRONTEND_ORIGIN}/license-management`
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Error creating portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Webhook handler for Stripe events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Helper function to handle checkout completion
async function handleCheckoutCompleted(session) {
  try {
    const email = session.customer_email || session.metadata.email;
    const quantity = parseInt(session.metadata.quantity);
    
    if (!email) {
      console.error('No email found in checkout session');
      return;
    }

    // Check if license already exists
    const existingLicense = await pool.query(
      'SELECT id FROM licenses WHERE account_id = $1',
      [email]
    );

    if (existingLicense.rows.length === 0) {
      // Create new license
      const licenseKey = generateLicenseKey(email);
      
      await pool.query(
        'INSERT INTO licenses (account_id, license_key, created_at) VALUES ($1, $2, NOW())',
        [email, licenseKey]
      );

      console.log(`Created license for ${email}: ${licenseKey}`);

      // Trigger GitHub Actions build
      await triggerGitHubBuild(email, licenseKey);
    }

  } catch (error) {
    console.error('Error handling checkout completion:', error);
  }
}

// Helper function to handle subscription changes
async function handleSubscriptionChange(subscription) {
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    const email = customer.email;
    const quantity = subscription.items.data[0].quantity;
    
    console.log(`Subscription updated for ${email}: ${quantity} devices`);
    
    // Update any cached data if needed
    // For V9, we fetch from Stripe directly, so no database updates needed
    
  } catch (error) {
    console.error('Error handling subscription change:', error);
  }
}

// Helper function to handle subscription deletion
async function handleSubscriptionDeleted(subscription) {
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    const email = customer.email;
    
    console.log(`Subscription deleted for ${email}`);
    
    // Handle subscription cancellation
    // License remains valid but no new builds
    
  } catch (error) {
    console.error('Error handling subscription deletion:', error);
  }
}

// Helper function to generate license key
function generateLicenseKey(email) {
  const timestamp = Date.now().toString();
  const crypto = require('crypto');
  const emailHash = crypto.createHash('md5').update(email).digest('hex').substring(0, 8);
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  
  return `SYNC-${timestamp.substring(-8)}-${emailHash.toUpperCase()}-${random}`;
}

// Helper function to trigger GitHub Actions build
async function triggerGitHubBuild(email, licenseKey) {
  try {
    const { Octokit } = await import('@octokit/rest');
    
    const octokit = new Octokit({
      auth: process.env.GITHUB_PAT
    });

    const tag = `customer-${Date.now()}`;
    
    await octokit.actions.createWorkflowDispatch({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      workflow_id: 'build.yml',
      ref: 'main',
      inputs: {
        tag: tag,
        license_key: licenseKey
      }
    });

    // Store build info in database
    await pool.query(
      `INSERT INTO builds (license_id, account_id, status, tag, created_at) 
       VALUES ((SELECT id FROM licenses WHERE account_id = $1), $1, 'building', $2, NOW())`,
      [email, tag]
    );

    console.log(`Triggered GitHub build for ${email} with tag ${tag}`);
    
  } catch (error) {
    console.error('Error triggering GitHub build:', error);
  }
}

export default router;


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

// V9 Dashboard Summary - Fetches data from Stripe
router.get('/summary', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }

    // Get Stripe customer and subscription data
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    let activeLicenses = 0;
    let tierInfo = null;
    let subscriptionStatus = 'none';

    if (customers.data.length > 0) {
      const customer = customers.data[0];
      
      // Get active subscriptions
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1
      });

      if (subscriptions.data.length > 0) {
        const subscription = subscriptions.data[0];
        activeLicenses = subscription.items.data[0].quantity;
        tierInfo = getTierInfo(activeLicenses);
        subscriptionStatus = subscription.status;
      }
    }

    // Get connected devices from database (device_bindings)
    const deviceQuery = await pool.query(
      `SELECT COUNT(*) as device_count 
       FROM device_bindings db 
       JOIN licenses l ON db.license_id = l.id 
       WHERE l.account_id = $1 AND db.status = 'active'`,
      [email]
    );

    const connectedDevices = parseInt(deviceQuery.rows[0].device_count) || 0;

    // Get healthy devices (devices with recent heartbeat)
    const healthyDeviceQuery = await pool.query(
      `SELECT COUNT(*) as healthy_count 
       FROM device_bindings db 
       JOIN licenses l ON db.license_id = l.id 
       WHERE l.account_id = $1 
       AND db.status = 'active' 
       AND db.last_heartbeat > NOW() - INTERVAL '5 minutes'`,
      [email]
    );

    const healthyDevices = parseInt(healthyDeviceQuery.rows[0].healthy_count) || 0;

    // Get build status
    const buildQuery = await pool.query(
      `SELECT status, tag, created_at, updated_at, release_url, asset_name
       FROM builds b
       JOIN licenses l ON b.license_id = l.id
       WHERE l.account_id = $1
       ORDER BY b.created_at DESC
       LIMIT 1`,
      [email]
    );

    let buildInfo = null;
    if (buildQuery.rows.length > 0) {
      const build = buildQuery.rows[0];
      buildInfo = {
        status: build.status,
        tag: build.tag,
        created_at: build.created_at,
        updated_at: build.updated_at,
        release_url: build.release_url,
        asset_name: build.asset_name
      };
    }

    // Calculate used licenses (connected devices)
    const usedLicenses = connectedDevices;

    res.json({
      activeLicenses: activeLicenses,
      usedLicenses: usedLicenses,
      availableLicenses: Math.max(0, activeLicenses - usedLicenses),
      connectedDevices: connectedDevices,
      healthyDevices: healthyDevices,
      subscriptionStatus: subscriptionStatus,
      tierInfo: tierInfo,
      buildInfo: buildInfo,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching V9 dashboard summary:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// V9 License Management Data
router.get('/license-management', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }

    // Get Stripe customer data
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.json({
        hasCustomer: false,
        hasSubscription: false,
        customer: null,
        subscription: null,
        tierInfo: null,
        paymentMethods: [],
        invoices: []
      });
    }

    const customer = customers.data[0];

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    let subscription = null;
    let tierInfo = null;

    if (subscriptions.data.length > 0) {
      subscription = subscriptions.data[0];
      const quantity = subscription.items.data[0].quantity;
      tierInfo = getTierInfo(quantity);
    }

    // Get payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.id,
      type: 'card'
    });

    // Get recent invoices
    const invoices = await stripe.invoices.list({
      customer: customer.id,
      limit: 5
    });

    res.json({
      hasCustomer: true,
      hasSubscription: subscription !== null,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        created: customer.created
      },
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        quantity: subscription.items.data[0].quantity,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        cancel_at_period_end: subscription.cancel_at_period_end,
        canceled_at: subscription.canceled_at
      } : null,
      tierInfo: tierInfo,
      paymentMethods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year
      })),
      invoices: invoices.data.map(invoice => ({
        id: invoice.id,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        status: invoice.status,
        created: invoice.created,
        invoice_pdf: invoice.invoice_pdf
      }))
    });

  } catch (error) {
    console.error('Error fetching license management data:', error);
    res.status(500).json({ error: 'Failed to fetch license management data' });
  }
});

// V9 Downloads Data
router.get('/downloads', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }

    // Check if customer has active subscription
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    let hasActiveSubscription = false;
    if (customers.data.length > 0) {
      const customer = customers.data[0];
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1
      });
      hasActiveSubscription = subscriptions.data.length > 0;
    }

    if (!hasActiveSubscription) {
      return res.json({
        hasSubscription: false,
        message: 'Purchase a license to receive your SyncSure monitor tool',
        downloadUrl: null,
        buildStatus: 'no_subscription'
      });
    }

    // Get license and build information
    const licenseQuery = await pool.query(
      'SELECT id, license_key FROM licenses WHERE account_id = $1',
      [email]
    );

    if (licenseQuery.rows.length === 0) {
      return res.json({
        hasSubscription: true,
        message: 'License is being created...',
        downloadUrl: null,
        buildStatus: 'creating_license'
      });
    }

    const license = licenseQuery.rows[0];

    // Get latest build
    const buildQuery = await pool.query(
      `SELECT status, tag, created_at, updated_at, release_url, asset_name, asset_api_url
       FROM builds 
       WHERE license_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [license.id]
    );

    if (buildQuery.rows.length === 0) {
      return res.json({
        hasSubscription: true,
        message: 'Your custom tool is being built...',
        downloadUrl: null,
        buildStatus: 'building',
        licenseKey: license.license_key
      });
    }

    const build = buildQuery.rows[0];

    let message = '';
    let downloadUrl = null;

    switch (build.status) {
      case 'building':
        message = 'Your custom tool is being built... This usually takes 2-3 minutes.';
        break;
      case 'completed':
        message = 'Your SyncSure tool is ready for download!';
        downloadUrl = build.release_url;
        break;
      case 'failed':
        message = 'Build failed. Please contact support.';
        break;
      default:
        message = 'Build status unknown. Please contact support.';
    }

    res.json({
      hasSubscription: true,
      message: message,
      downloadUrl: downloadUrl,
      buildStatus: build.status,
      licenseKey: license.license_key,
      buildInfo: {
        tag: build.tag,
        created_at: build.created_at,
        updated_at: build.updated_at,
        asset_name: build.asset_name,
        asset_api_url: build.asset_api_url
      }
    });

  } catch (error) {
    console.error('Error fetching downloads data:', error);
    res.status(500).json({ error: 'Failed to fetch downloads data' });
  }
});

// V9 Device List
router.get('/devices', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }

    const deviceQuery = await pool.query(
      `SELECT 
        db.id,
        db.device_id,
        db.device_name,
        db.bound_at,
        db.last_heartbeat,
        db.agent_version,
        db.status,
        db.system_info,
        l.license_key
       FROM device_bindings db 
       JOIN licenses l ON db.license_id = l.id 
       WHERE l.account_id = $1 
       ORDER BY db.last_heartbeat DESC`,
      [email]
    );

    const devices = deviceQuery.rows.map(device => ({
      id: device.id,
      deviceId: device.device_id,
      deviceName: device.device_name,
      boundAt: device.bound_at,
      lastHeartbeat: device.last_heartbeat,
      agentVersion: device.agent_version,
      status: device.status,
      systemInfo: device.system_info,
      licenseKey: device.license_key,
      isHealthy: device.last_heartbeat && 
                 new Date(device.last_heartbeat) > new Date(Date.now() - 5 * 60 * 1000)
    }));

    res.json({
      devices: devices,
      totalDevices: devices.length,
      healthyDevices: devices.filter(d => d.isHealthy).length,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

export default router;


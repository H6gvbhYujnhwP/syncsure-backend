import express from 'express';
import { pool as db } from '../db.js';

const router = express.Router();

// V9 Dashboard Summary - No authentication required for dashboard access
router.get('/summary', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter is required'
      });
    }

    console.log(`[V9 Dashboard] Fetching summary for: ${email}`);

    // Get account
    const accountResult = await db.query(
      'SELECT id, email, company_name, stripe_customer_id FROM accounts WHERE email = $1',
      [email]
    );

    if (accountResult.rows.length === 0) {
      console.log(`[V9 Dashboard] Account not found: ${email}`);
      return res.json({
        success: true,
        account: null,
        license: null,
        subscription: null,
        summary: {
          activeLicenses: 0,
          deviceCount: 0,
          boundCount: 0,
          pricingTier: 'none',
          status: 'inactive'
        }
      });
    }

    const account = accountResult.rows[0];
    console.log(`[V9 Dashboard] Account found: ${account.id}`);

    // Get license
    const licenseResult = await db.query(
      'SELECT * FROM licenses WHERE account_id = $1',
      [account.id]
    );

    let license = null;
    if (licenseResult.rows.length > 0) {
      license = licenseResult.rows[0];
      console.log(`[V9 Dashboard] License found: ${license.id}, device_count: ${license.device_count}`);
    }

    // Get subscription
    const subscriptionResult = await db.query(
      'SELECT * FROM subscriptions WHERE account_id = $1 AND status = $2',
      [account.id, 'active']
    );

    let subscription = null;
    if (subscriptionResult.rows.length > 0) {
      subscription = subscriptionResult.rows[0];
      console.log(`[V9 Dashboard] Subscription found: ${subscription.stripe_subscription_id}`);
    }

    // Build summary
    const summary = {
      activeLicenses: license ? 1 : 0,
      deviceCount: license ? license.device_count : 0,
      boundCount: license ? license.bound_count : 0,
      pricingTier: license ? license.pricing_tier : 'none',
      status: subscription ? subscription.status : 'inactive',
      pricePerDevice: license ? license.price_per_device : 0
    };

    console.log(`[V9 Dashboard] Summary generated:`, summary);

    res.json({
      success: true,
      account: {
        id: account.id,
        email: account.email,
        company_name: account.company_name,
        stripe_customer_id: account.stripe_customer_id
      },
      license: license,
      subscription: subscription,
      summary: summary
    });

  } catch (error) {
    console.error('[V9 Dashboard] Summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard summary',
      details: error.message
    });
  }
});

// V9 Devices endpoint
router.get('/devices/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    console.log(`[V9 Devices] Fetching devices for: ${email}`);

    // Get account
    const accountResult = await db.query(
      'SELECT id FROM accounts WHERE email = $1',
      [email]
    );

    if (accountResult.rows.length === 0) {
      return res.json({
        success: true,
        devices: [],
        message: 'No account found'
      });
    }

    const accountId = accountResult.rows[0].id;

    // Get devices from device_bindings table
    const devicesResult = await db.query(`
      SELECT 
        db.id,
        db.device_name,
        db.device_id,
        db.system_info,
        db.last_heartbeat,
        db.created_at,
        db.updated_at,
        CASE 
          WHEN db.last_heartbeat > NOW() - INTERVAL '5 minutes' THEN 'healthy'
          WHEN db.last_heartbeat > NOW() - INTERVAL '1 hour' THEN 'warning'
          ELSE 'offline'
        END as status
      FROM device_bindings db
      JOIN licenses l ON db.license_id = l.id
      WHERE l.account_id = $1
      ORDER BY db.last_heartbeat DESC
    `, [accountId]);

    const devices = devicesResult.rows.map(device => ({
      id: device.id,
      name: device.device_name || device.device_id,
      lastSeen: device.last_heartbeat ? 
        new Date(device.last_heartbeat).toLocaleString() : 'Never',
      status: device.status,
      event: device.status === 'healthy' ? 'Heartbeat received' : 
             device.status === 'warning' ? 'Delayed heartbeat' : 'No recent activity',
      message: device.system_info ? JSON.parse(device.system_info).os || 'Unknown OS' : 'No system info'
    }));

    console.log(`[V9 Devices] Found ${devices.length} devices`);

    res.json({
      success: true,
      devices: devices,
      count: devices.length
    });

  } catch (error) {
    console.error('[V9 Devices] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch devices',
      details: error.message
    });
  }
});

// V9 Builds endpoint
router.get('/builds/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    console.log(`[V9 Builds] Fetching builds for: ${email}`);

    // Get account
    const accountResult = await db.query(
      'SELECT id FROM accounts WHERE email = $1',
      [email]
    );

    if (accountResult.rows.length === 0) {
      return res.json({
        success: true,
        builds: [],
        message: 'No account found'
      });
    }

    const accountId = accountResult.rows[0].id;

    // Get license
    const licenseResult = await db.query(
      'SELECT * FROM licenses WHERE account_id = $1',
      [accountId]
    );

    if (licenseResult.rows.length === 0) {
      return res.json({
        success: true,
        builds: [],
        message: 'No license found'
      });
    }

    const license = licenseResult.rows[0];

    // Check if builds table exists and get builds
    let builds = [];
    try {
      const buildsResult = await db.query(`
        SELECT * FROM builds 
        WHERE license_key = $1 
        ORDER BY created_at DESC
      `, [license.license_key]);

      builds = buildsResult.rows.map(build => ({
        id: build.id,
        license_key: build.license_key,
        pricing_tier: license.pricing_tier,
        tag: build.tag || 'v1.0.0',
        status: build.status || 'released',
        created_at: build.created_at,
        updated_at: build.updated_at
      }));

    } catch (buildError) {
      console.log('[V9 Builds] Builds table may not exist, creating placeholder build');
      
      // Create a placeholder build entry for the license
      builds = [{
        id: `build-${license.id.slice(-8)}`,
        license_key: license.license_key,
        pricing_tier: license.pricing_tier,
        tag: 'v1.0.0',
        status: 'building',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }];
    }

    console.log(`[V9 Builds] Found ${builds.length} builds`);

    res.json({
      success: true,
      builds: builds,
      count: builds.length
    });

  } catch (error) {
    console.error('[V9 Builds] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch builds',
      details: error.message
    });
  }
});

export default router;


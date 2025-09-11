/**
 * SyncSure V9 Dashboard Routes
 * Self-healing dashboard with single-license system
 */

const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../config/database');
const { getLicenseSummary } = require('../utils/licenseManager');
const { getDownloadLinksForLicense, ensureBuildForLicense } = require('../utils/buildManager');
const { getTierDisplayName } = require('../utils/tierMapping');

// Authentication middleware
const requireAuth = (req, res, next) => {
  // TODO: Implement proper session-based authentication
  // For now, we'll use a simple check
  if (!req.session || !req.session.accountId) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }
  next();
};

/**
 * Check if account needs sync from Stripe
 */
async function needsStripeSync(accountId) {
  try {
    // Check if account has license and subscription
    const result = await pool.query(`
      SELECT 
        a.stripe_customer_id,
        l.id as license_id,
        s.id as subscription_id,
        s.status as subscription_status
      FROM accounts a
      LEFT JOIN licenses l ON l.account_id = a.id
      LEFT JOIN subscriptions s ON s.account_id = a.id
      WHERE a.id = $1
    `, [accountId]);

    if (result.rows.length === 0) {
      return { needsSync: true, reason: 'account_not_found' };
    }

    const data = result.rows[0];

    // No license exists
    if (!data.license_id) {
      return { needsSync: true, reason: 'no_license' };
    }

    // No subscription exists
    if (!data.subscription_id) {
      return { needsSync: true, reason: 'no_subscription' };
    }

    // Check if Stripe has active subscription but local status is wrong
    if (data.stripe_customer_id) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: data.stripe_customer_id,
          status: 'all',
          limit: 1
        });

        const activeSubscription = subscriptions.data.find(s => 
          ['active', 'trialing', 'past_due'].includes(s.status)
        );

        if (activeSubscription && data.subscription_status !== activeSubscription.status) {
          return { needsSync: true, reason: 'status_mismatch' };
        }
      } catch (error) {
        console.error('Error checking Stripe subscription:', error);
      }
    }

    return { needsSync: false };
  } catch (error) {
    console.error('Error checking sync needs:', error);
    return { needsSync: true, reason: 'error' };
  }
}

/**
 * Sync account from Stripe
 */
async function syncAccountFromStripe(accountId) {
  try {
    // Get account details
    const accountResult = await pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [accountId]
    );

    if (accountResult.rows.length === 0) {
      throw new Error('Account not found');
    }

    const account = accountResult.rows[0];

    if (!account.stripe_customer_id) {
      throw new Error('No Stripe customer ID');
    }

    // Get active subscriptions from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: account.stripe_customer_id,
      status: 'all'
    });

    const activeSubscription = subscriptions.data.find(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );

    if (!activeSubscription) {
      throw new Error('No active subscription found');
    }

    // Process subscription (reuse webhook logic)
    const { processStripeSubscription } = require('./stripe-v9');
    await processStripeSubscription(activeSubscription, 'dashboard_sync', `dashboard_${Date.now()}`);

    console.log(`[V9] Dashboard sync completed for account ${accountId}`);
    return true;
  } catch (error) {
    console.error(`[V9] Dashboard sync error for account ${accountId}:`, error);
    throw error;
  }
}

/**
 * Get comprehensive dashboard summary
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const accountId = req.session.accountId;
    
    console.log(`[V9] Getting dashboard summary for account ${accountId}`);

    // Check if sync is needed
    const syncCheck = await needsStripeSync(accountId);
    
    if (syncCheck.needsSync) {
      console.log(`[V9] Account ${accountId} needs sync: ${syncCheck.reason}`);
      
      try {
        await syncAccountFromStripe(accountId);
      } catch (syncError) {
        console.error(`[V9] Sync failed for account ${accountId}:`, syncError);
        
        return res.json({
          success: true,
          status: 'sync_failed',
          error: syncError.message,
          data: null
        });
      }
    }

    // Get license summary
    const licenseSummary = await getLicenseSummary(accountId);
    
    if (!licenseSummary) {
      return res.json({
        success: true,
        status: 'no_license',
        data: {
          subscription: null,
          license: null,
          downloads: null
        }
      });
    }

    // Get download links
    let downloads = null;
    let buildStatus = 'unknown';
    
    try {
      downloads = await getDownloadLinksForLicense(licenseSummary.id);
      
      if (!downloads) {
        // Try to ensure build exists
        const buildResult = await ensureBuildForLicense(licenseSummary.id, accountId);
        buildStatus = buildResult.status;
      } else {
        buildStatus = 'completed';
      }
    } catch (buildError) {
      console.error('Error getting downloads:', buildError);
      buildStatus = 'error';
    }

    // Format response
    const summary = {
      subscription: {
        status: licenseSummary.subscription_status,
        deviceQuantity: licenseSummary.subscription_quantity || licenseSummary.device_count,
        currentPeriodEnd: licenseSummary.current_period_end,
        tier: getTierDisplayName(licenseSummary.pricing_tier),
        pricePerDevice: licenseSummary.price_per_device
      },
      license: {
        key: licenseSummary.license_key,
        deviceCount: licenseSummary.device_count,
        boundCount: licenseSummary.bound_count,
        availableDevices: licenseSummary.available_devices,
        usagePercentage: licenseSummary.usage_percentage,
        isOverLimit: licenseSummary.is_over_limit,
        pricingTier: licenseSummary.pricing_tier,
        pricePerDevice: licenseSummary.price_per_device,
        status: licenseSummary.status
      },
      downloads: downloads,
      buildStatus: buildStatus
    };

    // Determine overall status
    let status = 'ok';
    if (buildStatus === 'pending' || buildStatus === 'building') {
      status = 'repairing';
    } else if (buildStatus === 'error' || buildStatus === 'failed') {
      status = 'build_error';
    } else if (!downloads) {
      status = 'no_downloads';
    }

    res.json({
      success: true,
      status: status,
      data: summary
    });

  } catch (error) {
    console.error('[V9] Dashboard summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dashboard summary'
    });
  }
});

/**
 * Get device bindings for account
 */
router.get('/devices', requireAuth, async (req, res) => {
  try {
    const accountId = req.session.accountId;

    const result = await pool.query(`
      SELECT 
        db.*,
        l.license_key,
        l.device_count,
        l.bound_count
      FROM device_bindings db
      JOIN licenses l ON l.id = db.license_id
      WHERE l.account_id = $1
      ORDER BY db.last_heartbeat DESC
    `, [accountId]);

    const devices = result.rows.map(device => ({
      id: device.id,
      deviceId: device.device_id,
      systemInfo: device.system_info,
      lastHeartbeat: device.last_heartbeat,
      status: device.status,
      createdAt: device.created_at
    }));

    res.json({
      success: true,
      devices: devices,
      summary: {
        total: devices.length,
        active: devices.filter(d => d.status === 'active').length,
        allowance: result.rows[0]?.device_count || 0
      }
    });

  } catch (error) {
    console.error('[V9] Get devices error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get devices'
    });
  }
});

/**
 * Get license management details
 */
router.get('/license', requireAuth, async (req, res) => {
  try {
    const accountId = req.session.accountId;

    const licenseSummary = await getLicenseSummary(accountId);
    
    if (!licenseSummary) {
      return res.status(404).json({
        success: false,
        error: 'No license found'
      });
    }

    // Get recent audit log
    const auditResult = await pool.query(`
      SELECT action, new_values, created_at
      FROM license_audit_log
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [accountId]);

    const auditLog = auditResult.rows.map(entry => ({
      action: entry.action,
      details: entry.new_values,
      timestamp: entry.created_at
    }));

    res.json({
      success: true,
      license: {
        key: licenseSummary.license_key,
        deviceCount: licenseSummary.device_count,
        boundCount: licenseSummary.bound_count,
        availableDevices: licenseSummary.available_devices,
        usagePercentage: licenseSummary.usage_percentage,
        isOverLimit: licenseSummary.is_over_limit,
        pricingTier: licenseSummary.pricing_tier,
        pricePerDevice: licenseSummary.price_per_device,
        status: licenseSummary.status,
        createdAt: licenseSummary.created_at,
        updatedAt: licenseSummary.updated_at
      },
      subscription: {
        status: licenseSummary.subscription_status,
        deviceQuantity: licenseSummary.subscription_quantity,
        currentPeriodEnd: licenseSummary.current_period_end
      },
      auditLog: auditLog
    });

  } catch (error) {
    console.error('[V9] Get license error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get license details'
    });
  }
});

/**
 * Get billing and subscription stats
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const accountId = req.session.accountId;

    // Get account with subscription info
    const result = await pool.query(`
      SELECT 
        a.*,
        s.status as subscription_status,
        s.device_quantity,
        s.current_period_end,
        l.device_count,
        l.bound_count,
        l.pricing_tier,
        l.price_per_device
      FROM accounts a
      LEFT JOIN subscriptions s ON s.account_id = a.id
      LEFT JOIN licenses l ON l.account_id = a.id
      WHERE a.id = $1
    `, [accountId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Account not found'
      });
    }

    const data = result.rows[0];

    // Calculate monthly cost
    const monthlyCost = (data.device_quantity || 0) * (data.price_per_device || 0);

    // Get device binding stats
    const deviceStats = await pool.query(`
      SELECT 
        COUNT(*) as total_bindings,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_bindings,
        MAX(last_heartbeat) as last_activity
      FROM device_bindings db
      JOIN licenses l ON l.id = db.license_id
      WHERE l.account_id = $1
    `, [accountId]);

    const stats = deviceStats.rows[0];

    res.json({
      success: true,
      stats: {
        subscription: {
          status: data.subscription_status,
          deviceQuantity: data.device_quantity,
          tier: getTierDisplayName(data.pricing_tier),
          pricePerDevice: data.price_per_device,
          monthlyCost: monthlyCost,
          currentPeriodEnd: data.current_period_end
        },
        usage: {
          deviceCount: data.device_count,
          boundCount: data.bound_count,
          totalBindings: parseInt(stats.total_bindings),
          activeBindings: parseInt(stats.active_bindings),
          lastActivity: stats.last_activity,
          usagePercentage: data.device_count > 0 
            ? Math.round((data.bound_count / data.device_count) * 100)
            : 0
        },
        account: {
          email: data.email,
          name: data.name,
          createdAt: data.created_at
        }
      }
    });

  } catch (error) {
    console.error('[V9] Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats'
    });
  }
});

module.exports = router;


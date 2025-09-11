/**
 * SyncSure V9 Dashboard Routes - ES6 Module Version
 * Self-healing dashboard with single-license system
 */

import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
 * Get tier display name
 */
function getTierDisplayName(tier) {
  switch (tier) {
    case 'starter': return 'Starter';
    case 'business': return 'Business';
    case 'enterprise': return 'Enterprise';
    default: return 'Unknown';
  }
}

/**
 * Get license summary for account
 */
async function getLicenseSummary(accountId) {
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        s.status as subscription_status,
        s.device_quantity as subscription_quantity,
        s.current_period_end,
        COALESCE(db.bound_count, 0) as bound_count,
        (l.device_count - COALESCE(db.bound_count, 0)) as available_devices,
        CASE 
          WHEN l.device_count > 0 THEN 
            ROUND((COALESCE(db.bound_count, 0)::decimal / l.device_count) * 100, 2)
          ELSE 0 
        END as usage_percentage,
        CASE 
          WHEN COALESCE(db.bound_count, 0) > l.device_count THEN true 
          ELSE false 
        END as is_over_limit
      FROM licenses l
      LEFT JOIN subscriptions s ON s.account_id = l.account_id
      LEFT JOIN (
        SELECT license_id, COUNT(*) as bound_count
        FROM device_bindings 
        WHERE status = 'active'
        GROUP BY license_id
      ) db ON db.license_id = l.id
      WHERE l.account_id = $1
    `, [accountId]);

    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting license summary:', error);
    throw error;
  }
}

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

    return { needsSync: false };
  } catch (error) {
    console.error('Error checking sync needs:', error);
    return { needsSync: true, reason: 'error' };
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
      
      return res.json({
        success: true,
        status: 'needs_sync',
        reason: syncCheck.reason,
        data: null
      });
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
      downloads: null, // TODO: Implement build management
      buildStatus: 'pending'
    };

    res.json({
      success: true,
      status: 'ok',
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

export default router;


/**
 * SyncSure V9 License Manager
 * Handles single-license per account logic
 */

const { pool } = require('../config/database');
const { mapTier } = require('./tierMapping');

/**
 * Ensure single license exists for account
 * Creates if missing, updates if exists
 * @param {number} accountId - Account ID
 * @param {Object} licenseData - License data to set
 * @returns {Object} - License record
 */
async function ensureSingleLicense(accountId, licenseData = {}) {
  try {
    // Check if license already exists
    const existingLicense = await pool.query(
      'SELECT * FROM licenses WHERE account_id = $1',
      [accountId]
    );
    
    if (existingLicense.rows.length > 0) {
      // Update existing license
      const license = existingLicense.rows[0];
      
      if (Object.keys(licenseData).length > 0) {
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;
        
        // Build dynamic update query
        Object.entries(licenseData).forEach(([key, value]) => {
          updateFields.push(`${key} = $${paramIndex}`);
          updateValues.push(value);
          paramIndex++;
        });
        
        if (updateFields.length > 0) {
          updateValues.push(license.id);
          const updateQuery = `
            UPDATE licenses 
            SET ${updateFields.join(', ')}, updated_at = NOW()
            WHERE id = $${paramIndex}
            RETURNING *
          `;
          
          const result = await pool.query(updateQuery, updateValues);
          
          // Log audit trail
          await logLicenseAudit(license.id, accountId, 'updated', license, result.rows[0]);
          
          return result.rows[0];
        }
      }
      
      return license;
    } else {
      // Create new license
      const licenseKey = generateLicenseKey();
      
      const createQuery = `
        INSERT INTO licenses (
          license_key, account_id, device_count, bound_count, 
          pricing_tier, price_per_device, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING *
      `;
      
      const values = [
        licenseKey,
        accountId,
        licenseData.device_count || 1,
        0, // bound_count starts at 0
        licenseData.pricing_tier || 'starter',
        licenseData.price_per_device || 1.99,
        licenseData.status || 'active'
      ];
      
      const result = await pool.query(createQuery, values);
      const newLicense = result.rows[0];
      
      // Log audit trail
      await logLicenseAudit(newLicense.id, accountId, 'created', null, newLicense);
      
      return newLicense;
    }
  } catch (error) {
    console.error('Error ensuring single license:', error);
    throw error;
  }
}

/**
 * Mirror subscription quantity to license device_count
 * @param {number} accountId - Account ID
 * @param {number} deviceQuantity - Device quantity from subscription
 * @returns {Object} - Updated license
 */
async function mirrorSubscriptionToLicense(accountId, deviceQuantity) {
  try {
    const { tier, price } = mapTier(deviceQuantity);
    
    const licenseData = {
      device_count: deviceQuantity,
      pricing_tier: tier,
      price_per_device: price
    };
    
    const license = await ensureSingleLicense(accountId, licenseData);
    
    // Log mirroring action
    await logLicenseAudit(license.id, accountId, 'mirrored', null, {
      device_count: deviceQuantity,
      pricing_tier: tier,
      price_per_device: price
    });
    
    return license;
  } catch (error) {
    console.error('Error mirroring subscription to license:', error);
    throw error;
  }
}

/**
 * Check if account can bind new devices
 * @param {number} accountId - Account ID
 * @returns {Object} - {canBind: boolean, reason: string, license: Object}
 */
async function checkBindingAllowance(accountId) {
  try {
    const license = await pool.query(
      'SELECT * FROM licenses WHERE account_id = $1',
      [accountId]
    );
    
    if (license.rows.length === 0) {
      return {
        canBind: false,
        reason: 'No license found for account',
        license: null
      };
    }
    
    const licenseData = license.rows[0];
    
    if (licenseData.status !== 'active') {
      return {
        canBind: false,
        reason: 'License is not active',
        license: licenseData
      };
    }
    
    if (licenseData.bound_count >= licenseData.device_count) {
      return {
        canBind: false,
        reason: 'Device limit reached',
        license: licenseData
      };
    }
    
    return {
      canBind: true,
      reason: 'Binding allowed',
      license: licenseData
    };
  } catch (error) {
    console.error('Error checking binding allowance:', error);
    throw error;
  }
}

/**
 * Generate unique license key
 * @returns {string} - License key
 */
function generateLicenseKey() {
  const prefix = 'SYNC';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substr(2, 8).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Log license audit trail
 * @param {number} licenseId - License ID
 * @param {number} accountId - Account ID
 * @param {string} action - Action performed
 * @param {Object} oldValues - Previous values
 * @param {Object} newValues - New values
 * @param {string} stripeEventId - Stripe event ID (optional)
 */
async function logLicenseAudit(licenseId, accountId, action, oldValues, newValues, stripeEventId = null) {
  try {
    await pool.query(`
      INSERT INTO license_audit_log (
        license_id, account_id, action, old_values, new_values, stripe_event_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      licenseId,
      accountId,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      stripeEventId
    ]);
  } catch (error) {
    console.error('Error logging license audit:', error);
    // Don't throw - audit logging shouldn't break main flow
  }
}

/**
 * Get license summary for account
 * @param {number} accountId - Account ID
 * @returns {Object} - License summary
 */
async function getLicenseSummary(accountId) {
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        a.email,
        s.status as subscription_status,
        s.device_quantity as subscription_quantity,
        s.current_period_end
      FROM licenses l
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN subscriptions s ON s.account_id = l.account_id
      WHERE l.account_id = $1
    `, [accountId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const license = result.rows[0];
    
    // Calculate usage percentage
    const usagePercentage = license.device_count > 0 
      ? Math.round((license.bound_count / license.device_count) * 100)
      : 0;
    
    // Check if over limit
    const isOverLimit = license.bound_count > license.device_count;
    
    return {
      ...license,
      usage_percentage: usagePercentage,
      is_over_limit: isOverLimit,
      available_devices: Math.max(0, license.device_count - license.bound_count)
    };
  } catch (error) {
    console.error('Error getting license summary:', error);
    throw error;
  }
}

module.exports = {
  ensureSingleLicense,
  mirrorSubscriptionToLicense,
  checkBindingAllowance,
  generateLicenseKey,
  logLicenseAudit,
  getLicenseSummary
};


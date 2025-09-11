/**
 * SyncSure V9 Tier Mapping Utility
 * Maps device quantities to pricing tiers and prices
 */

/**
 * Map device quantity to pricing tier and price per device
 * @param {number} quantity - Number of devices
 * @returns {Object} - {tier: string, price: number}
 */
function mapTier(quantity) {
  const qty = parseInt(quantity) || 1;
  
  if (qty <= 50) {
    return {
      tier: 'starter',
      price: 1.99
    };
  }
  
  if (qty <= 500) {
    return {
      tier: 'business', 
      price: 1.49
    };
  }
  
  return {
    tier: 'enterprise',
    price: 0.99
  };
}

/**
 * Get tier display name
 * @param {string} tier - Tier code (starter, business, enterprise)
 * @returns {string} - Display name
 */
function getTierDisplayName(tier) {
  const displayNames = {
    'starter': 'Starter',
    'business': 'Business',
    'enterprise': 'Enterprise'
  };
  
  return displayNames[tier] || 'Starter';
}

/**
 * Get tier limits
 * @param {string} tier - Tier code
 * @returns {Object} - {min: number, max: number|null}
 */
function getTierLimits(tier) {
  const limits = {
    'starter': { min: 1, max: 50 },
    'business': { min: 51, max: 500 },
    'enterprise': { min: 501, max: null }
  };
  
  return limits[tier] || limits['starter'];
}

/**
 * Validate quantity for tier
 * @param {number} quantity - Device quantity
 * @param {string} tier - Tier code
 * @returns {boolean} - Whether quantity is valid for tier
 */
function validateQuantityForTier(quantity, tier) {
  const limits = getTierLimits(tier);
  const qty = parseInt(quantity) || 1;
  
  if (qty < limits.min) return false;
  if (limits.max && qty > limits.max) return false;
  
  return true;
}

/**
 * Calculate monthly cost for quantity
 * @param {number} quantity - Device quantity
 * @returns {number} - Monthly cost in GBP
 */
function calculateMonthlyCost(quantity) {
  const { price } = mapTier(quantity);
  return (parseInt(quantity) || 1) * price;
}

/**
 * Get all available tiers with their details
 * @returns {Array} - Array of tier objects
 */
function getAllTiers() {
  return [
    {
      code: 'starter',
      name: 'Starter',
      minDevices: 1,
      maxDevices: 50,
      pricePerDevice: 1.99,
      description: 'Perfect for small teams and individual users'
    },
    {
      code: 'business',
      name: 'Business', 
      minDevices: 51,
      maxDevices: 500,
      pricePerDevice: 1.49,
      description: 'Ideal for growing businesses and medium teams'
    },
    {
      code: 'enterprise',
      name: 'Enterprise',
      minDevices: 501,
      maxDevices: null,
      pricePerDevice: 0.99,
      description: 'Scalable solution for large organizations'
    }
  ];
}

module.exports = {
  mapTier,
  getTierDisplayName,
  getTierLimits,
  validateQuantityForTier,
  calculateMonthlyCost,
  getAllTiers
};


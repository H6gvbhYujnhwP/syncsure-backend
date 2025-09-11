/**
 * Field Name Normalizer Middleware
 * Handles conversion between camelCase and PascalCase field names
 * to support both C# agent (PascalCase) and JavaScript conventions (camelCase)
 */

/**
 * Convert PascalCase to camelCase
 * @param {string} str - PascalCase string
 * @returns {string} - camelCase string
 */
function pascalToCamel(str) {
  if (!str || typeof str !== 'string') return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}

/**
 * Convert camelCase to PascalCase
 * @param {string} str - camelCase string
 * @returns {string} - PascalCase string
 */
function camelToPascal(str) {
  if (!str || typeof str !== 'string') return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Recursively normalize object keys from PascalCase to camelCase
 * @param {any} obj - Object to normalize
 * @returns {any} - Object with normalized keys
 */
function normalizeObjectKeys(obj) {
  if (obj === null || obj === undefined) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(normalizeObjectKeys);
  }
  
  if (typeof obj === 'object') {
    const normalized = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = pascalToCamel(key);
      normalized[camelKey] = normalizeObjectKeys(value);
    }
    return normalized;
  }
  
  return obj;
}

/**
 * Create a normalized request body that supports both naming conventions
 * @param {object} body - Original request body
 * @returns {object} - Enhanced body with both naming conventions
 */
function createDualCaseBody(body) {
  if (!body || typeof body !== 'object') return body;
  
  const enhanced = { ...body };
  
  // Add camelCase versions of PascalCase fields
  for (const [key, value] of Object.entries(body)) {
    const camelKey = pascalToCamel(key);
    if (camelKey !== key && !enhanced[camelKey]) {
      enhanced[camelKey] = value;
    }
  }
  
  // Add PascalCase versions of camelCase fields
  for (const [key, value] of Object.entries(body)) {
    const pascalKey = camelToPascal(key);
    if (pascalKey !== key && !enhanced[pascalKey]) {
      enhanced[pascalKey] = value;
    }
  }
  
  return enhanced;
}

/**
 * Middleware to normalize field names in request bodies
 * Supports both camelCase and PascalCase by creating dual-case request body
 */
const fieldNameNormalizer = (req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') {
      // Create enhanced body with both naming conventions
      req.body = createDualCaseBody(req.body);
      
      // Add normalized version for consistent access
      req.normalizedBody = normalizeObjectKeys(req.body);
      
      // Log field name conversion for debugging
      if (process.env.NODE_ENV === 'development') {
        const originalKeys = Object.keys(req.body).filter(key => 
          key.charAt(0) === key.charAt(0).toUpperCase()
        );
        if (originalKeys.length > 0) {
          console.log(`🔄 Field name normalization applied for keys: ${originalKeys.join(', ')}`);
        }
      }
    }
    
    next();
  } catch (error) {
    console.error('Field name normalization error:', error);
    // Don't fail the request, just continue without normalization
    next();
  }
};

/**
 * Helper function to get field value supporting both naming conventions
 * @param {object} obj - Object to search
 * @param {string} fieldName - Field name in camelCase
 * @returns {any} - Field value
 */
function getFieldValue(obj, fieldName) {
  if (!obj || typeof obj !== 'object') return undefined;
  
  const camelCase = fieldName;
  const pascalCase = camelToPascal(fieldName);
  
  return obj[camelCase] ?? obj[pascalCase];
}

/**
 * Helper function to extract multiple field values with fallback support
 * @param {object} obj - Object to search
 * @param {string[]} fieldNames - Array of field names in camelCase
 * @returns {object} - Object with extracted values
 */
function extractFields(obj, fieldNames) {
  const result = {};
  
  for (const fieldName of fieldNames) {
    result[fieldName] = getFieldValue(obj, fieldName);
  }
  
  return result;
}

export {
  fieldNameNormalizer,
  getFieldValue,
  extractFields,
  normalizeObjectKeys,
  createDualCaseBody,
  pascalToCamel,
  camelToPascal
};


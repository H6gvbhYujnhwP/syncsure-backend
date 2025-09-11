/**
 * Comprehensive Logging Middleware for SyncSure Backend
 * Provides detailed logging for operations, errors, and monitoring
 */

import { pool } from "../db.js";

/**
 * Enhanced request logging middleware
 * Logs all API requests with timing and user context
 */
export const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  const requestId = generateRequestId();
  
  // Attach request ID to request for correlation
  req.requestId = requestId;
  
  // Log request start
  const logData = {
    requestId,
    method: req.method,
    url: req.url,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
    timestamp: new Date().toISOString(),
    userId: req.user?.accountId || null,
    sessionId: req.user?.sessionId || null
  };
  
  console.log(`🔄 [${requestId}] ${req.method} ${req.url} - Started`, {
    ...logData,
    body: req.method === 'POST' ? sanitizeRequestBody(req.body) : undefined
  });
  
  // Override res.json to log responses
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    console.log(`✅ [${requestId}] ${req.method} ${req.url} - Completed (${duration}ms)`, {
      ...logData,
      statusCode: res.statusCode,
      duration,
      responseSize: JSON.stringify(data).length
    });
    
    return originalJson.call(this, data);
  };
  
  // Log errors
  const originalStatus = res.status;
  res.status = function(code) {
    if (code >= 400) {
      const duration = Date.now() - startTime;
      console.error(`❌ [${requestId}] ${req.method} ${req.url} - Error ${code} (${duration}ms)`, {
        ...logData,
        statusCode: code,
        duration
      });
    }
    return originalStatus.call(this, code);
  };
  
  next();
};

/**
 * Agent operation logger
 * Specifically logs agent binding and heartbeat operations
 */
export const agentOperationLogger = async (operation, data, success = true, error = null) => {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      success,
      data: sanitizeAgentData(data),
      error: error ? {
        message: error.message,
        stack: error.stack,
        code: error.code
      } : null
    };
    
    // Console logging
    if (success) {
      console.log(`🤖 Agent ${operation} successful:`, logEntry);
    } else {
      console.error(`🚨 Agent ${operation} failed:`, logEntry);
    }
    
    // Database logging for important operations
    if (['device_bind', 'device_heartbeat', 'license_validation'].includes(operation)) {
      await logToDatabase('agent_operation', logEntry);
    }
    
  } catch (logError) {
    console.error('Logging error:', logError);
  }
};

/**
 * Authentication operation logger
 */
export const authOperationLogger = async (operation, userId, success = true, details = {}, error = null) => {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      userId,
      success,
      details: sanitizeAuthData(details),
      error: error ? {
        message: error.message,
        code: error.code
      } : null
    };
    
    // Console logging
    if (success) {
      console.log(`🔐 Auth ${operation} successful:`, logEntry);
    } else {
      console.error(`🚨 Auth ${operation} failed:`, logEntry);
    }
    
    // Database logging for security events
    await logToDatabase('auth_operation', logEntry);
    
  } catch (logError) {
    console.error('Auth logging error:', logError);
  }
};

/**
 * Database operation logger
 */
export const dbOperationLogger = async (operation, table, success = true, details = {}, error = null) => {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      table,
      success,
      details,
      error: error ? {
        message: error.message,
        code: error.code,
        detail: error.detail
      } : null
    };
    
    // Console logging
    if (success) {
      console.log(`🗄️ DB ${operation} on ${table}:`, logEntry);
    } else {
      console.error(`🚨 DB ${operation} on ${table} failed:`, logEntry);
    }
    
  } catch (logError) {
    console.error('DB logging error:', logError);
  }
};

/**
 * Performance monitoring logger
 */
export const performanceLogger = (operation, duration, details = {}) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation,
    duration,
    details
  };
  
  // Log slow operations
  if (duration > 1000) {
    console.warn(`⚠️ Slow operation detected:`, logEntry);
  } else {
    console.log(`⚡ Performance log:`, logEntry);
  }
};

/**
 * Error tracking middleware
 * Catches and logs unhandled errors
 */
export const errorHandler = async (err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  
  const errorLog = {
    requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    userId: req.user?.accountId || null,
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code
    },
    body: sanitizeRequestBody(req.body),
    headers: sanitizeHeaders(req.headers)
  };
  
  console.error(`💥 Unhandled error [${requestId}]:`, errorLog);
  
  // Log critical errors to database
  try {
    await logToDatabase('error', errorLog);
  } catch (logError) {
    console.error('Failed to log error to database:', logError);
  }
  
  // Send error response
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: "Internal server error",
      requestId: requestId
    });
  }
};

/**
 * Heartbeat monitoring logger
 * Tracks heartbeat patterns and issues
 */
export const heartbeatMonitor = {
  async logHeartbeat(licenseId, deviceId, success, details = {}) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        licenseId,
        deviceId,
        success,
        details
      };
      
      console.log(`💓 Heartbeat ${success ? 'received' : 'failed'}:`, logEntry);
      
      // Track heartbeat patterns
      await this.updateHeartbeatStats(licenseId, deviceId, success);
      
    } catch (error) {
      console.error('Heartbeat monitoring error:', error);
    }
  },
  
  async updateHeartbeatStats(licenseId, deviceId, success) {
    try {
      // Update heartbeat statistics in database
      const statsQuery = `
        INSERT INTO heartbeat_stats (license_id, device_id, date, successful_count, failed_count)
        VALUES ($1, $2, CURRENT_DATE, $3, $4)
        ON CONFLICT (license_id, device_id, date)
        DO UPDATE SET
          successful_count = heartbeat_stats.successful_count + $3,
          failed_count = heartbeat_stats.failed_count + $4,
          updated_at = NOW()
      `;
      
      await pool.query(statsQuery, [
        licenseId,
        deviceId,
        success ? 1 : 0,
        success ? 0 : 1
      ]);
      
    } catch (error) {
      console.error('Heartbeat stats update error:', error);
    }
  },
  
  async getHeartbeatHealth(licenseId) {
    try {
      const healthQuery = `
        SELECT 
          device_id,
          SUM(successful_count) as total_successful,
          SUM(failed_count) as total_failed,
          MAX(date) as last_heartbeat_date
        FROM heartbeat_stats
        WHERE license_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY device_id
      `;
      
      const result = await pool.query(healthQuery, [licenseId]);
      return result.rows;
      
    } catch (error) {
      console.error('Heartbeat health check error:', error);
      return [];
    }
  }
};

/**
 * Log to database for persistent storage
 */
async function logToDatabase(type, data) {
  try {
    const query = `
      INSERT INTO system_logs (type, data, created_at)
      VALUES ($1, $2, NOW())
    `;
    
    await pool.query(query, [type, JSON.stringify(data)]);
  } catch (error) {
    console.error('Database logging failed:', error);
  }
}

/**
 * Sanitize request body for logging (remove sensitive data)
 */
function sanitizeRequestBody(body) {
  if (!body) return null;
  
  const sanitized = { ...body };
  
  // Remove sensitive fields
  const sensitiveFields = ['password', 'token', 'secret', 'key'];
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });
  
  return sanitized;
}

/**
 * Sanitize agent data for logging
 */
function sanitizeAgentData(data) {
  if (!data) return null;
  
  const sanitized = { ...data };
  
  // Truncate long fields
  if (sanitized.systemMetrics && typeof sanitized.systemMetrics === 'string') {
    sanitized.systemMetrics = sanitized.systemMetrics.substring(0, 500) + '...';
  }
  
  return sanitized;
}

/**
 * Sanitize auth data for logging
 */
function sanitizeAuthData(data) {
  if (!data) return null;
  
  const sanitized = { ...data };
  
  // Remove sensitive auth fields
  delete sanitized.password;
  delete sanitized.token;
  delete sanitized.sessionId;
  
  return sanitized;
}

/**
 * Sanitize headers for logging
 */
function sanitizeHeaders(headers) {
  if (!headers) return null;
  
  const sanitized = { ...headers };
  
  // Remove sensitive headers
  delete sanitized.authorization;
  delete sanitized.cookie;
  
  return sanitized;
}

/**
 * Generate unique request ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export default {
  requestLogger,
  agentOperationLogger,
  authOperationLogger,
  dbOperationLogger,
  performanceLogger,
  errorHandler,
  heartbeatMonitor
};


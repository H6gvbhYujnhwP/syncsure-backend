/**
 * Authentication Middleware for SyncSure Dashboard
 * Handles session-based authentication and user authorization
 */

import { pool } from "../db.js";

/**
 * Middleware to check if user is authenticated
 * Validates session and attaches user information to request
 */
export const requireAuth = async (req, res, next) => {
  try {
    // Check for session cookie or authorization header
    const sessionId = req.cookies?.session_id || req.headers.authorization?.replace('Bearer ', '');
    
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        code: "NO_SESSION"
      });
    }

    // Validate session in database
    const sessionQuery = `
      SELECT 
        s.id,
        s.account_id,
        s.expires_at,
        a.email,
        a.status as account_status,
        a.subscription_status
      FROM sessions s
      JOIN accounts a ON s.account_id = a.id
      WHERE s.id = $1 AND s.expires_at > NOW() AND s.status = 'active'
    `;
    
    const sessionResult = await pool.query(sessionQuery, [sessionId]);
    
    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired session",
        code: "INVALID_SESSION"
      });
    }

    const session = sessionResult.rows[0];
    
    // Check if account is active
    if (session.account_status !== 'active') {
      return res.status(403).json({
        success: false,
        error: "Account is not active",
        code: "ACCOUNT_INACTIVE"
      });
    }

    // Attach user information to request
    req.user = {
      accountId: session.account_id,
      email: session.email,
      subscriptionStatus: session.subscription_status,
      sessionId: session.id
    };

    // Update session last_accessed
    await pool.query(
      "UPDATE sessions SET last_accessed = NOW() WHERE id = $1",
      [sessionId]
    );

    next();
  } catch (error) {
    console.error("Authentication middleware error:", error);
    res.status(500).json({
      success: false,
      error: "Authentication service error"
    });
  }
};

/**
 * Middleware to check if user has an active subscription
 */
export const requireActiveSubscription = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: "Authentication required"
    });
  }

  if (req.user.subscriptionStatus !== 'active') {
    return res.status(403).json({
      success: false,
      error: "Active subscription required",
      code: "SUBSCRIPTION_REQUIRED"
    });
  }

  next();
};

/**
 * Middleware to get user's license information
 * Attaches license data to request for dashboard operations
 */
export const attachUserLicense = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    // Get user's active license
    const licenseQuery = `
      SELECT 
        id,
        license_key,
        device_count,
        bound_count,
        pricing_tier,
        last_sync,
        status,
        created_at,
        updated_at
      FROM licenses 
      WHERE account_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    const licenseResult = await pool.query(licenseQuery, [req.user.accountId]);
    
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No active license found",
        code: "NO_LICENSE"
      });
    }

    req.license = licenseResult.rows[0];
    next();
  } catch (error) {
    console.error("License attachment error:", error);
    res.status(500).json({
      success: false,
      error: "License service error"
    });
  }
};

/**
 * Helper function to create a new session
 * @param {string} accountId - Account ID
 * @param {string} userAgent - User agent string
 * @param {string} ipAddress - Client IP address
 * @returns {object} - Session information
 */
export const createSession = async (accountId, userAgent = '', ipAddress = '') => {
  try {
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const insertQuery = `
      INSERT INTO sessions (id, account_id, expires_at, user_agent, ip_address, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
      RETURNING id, expires_at
    `;
    
    const result = await pool.query(insertQuery, [
      sessionId,
      accountId,
      expiresAt,
      userAgent,
      ipAddress
    ]);

    return {
      sessionId: result.rows[0].id,
      expiresAt: result.rows[0].expires_at
    };
  } catch (error) {
    console.error("Session creation error:", error);
    throw new Error("Failed to create session");
  }
};

/**
 * Helper function to invalidate a session
 * @param {string} sessionId - Session ID to invalidate
 */
export const invalidateSession = async (sessionId) => {
  try {
    await pool.query(
      "UPDATE sessions SET status = 'expired', updated_at = NOW() WHERE id = $1",
      [sessionId]
    );
  } catch (error) {
    console.error("Session invalidation error:", error);
    throw new Error("Failed to invalidate session");
  }
};

/**
 * Generate a secure session ID
 * @returns {string} - Random session ID
 */
function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 64; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Middleware for optional authentication
 * Attaches user info if authenticated, but doesn't require it
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const sessionId = req.cookies?.session_id || req.headers.authorization?.replace('Bearer ', '');
    
    if (sessionId) {
      const sessionQuery = `
        SELECT 
          s.id,
          s.account_id,
          s.expires_at,
          a.email,
          a.status as account_status,
          a.subscription_status
        FROM sessions s
        JOIN accounts a ON s.account_id = a.id
        WHERE s.id = $1 AND s.expires_at > NOW() AND s.status = 'active'
      `;
      
      const sessionResult = await pool.query(sessionQuery, [sessionId]);
      
      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        
        if (session.account_status === 'active') {
          req.user = {
            accountId: session.account_id,
            email: session.email,
            subscriptionStatus: session.subscription_status,
            sessionId: session.id
          };
          
          // Update session last_accessed
          await pool.query(
            "UPDATE sessions SET last_accessed = NOW() WHERE id = $1",
            [sessionId]
          );
        }
      }
    }
    
    next();
  } catch (error) {
    console.error("Optional auth middleware error:", error);
    // Continue without authentication on error
    next();
  }
};

export default {
  requireAuth,
  requireActiveSubscription,
  attachUserLicense,
  createSession,
  invalidateSession,
  optionalAuth
};


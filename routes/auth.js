import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { createSession, invalidateSession } from "../middleware/auth.js";

const router = express.Router();

// JWT secret (in production, this should be in environment variables)
const JWT_SECRET = process.env.JWT_SECRET || "syncsure-dev-secret-key";

// Account creation endpoint
router.post("/register", async (req, res) => {
  const { 
    email, 
    password,
    firstName,
    lastName,
    companyName
  } = req.body || {};

  // Validation
  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ 
      ok: false, 
      error: "Email, password, first name, and last name are required" 
    });
  }

  // Password strength validation
  if (password.length < 8) {
    return res.status(400).json({ 
      ok: false, 
      error: "Password must be at least 8 characters long" 
    });
  }

  try {
    // Check if account already exists
    const existingAccount = await pool.query(
      "SELECT id FROM accounts WHERE email = $1",
      [email]
    );

    if (existingAccount.rows.length > 0) {
      return res.status(400).json({ 
        ok: false, 
        error: "Account with this email already exists" 
      });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create account
    const fullName = `${firstName} ${lastName}`;
    const account = await pool.query(`
      INSERT INTO accounts (email, password_hash, name, role)
      VALUES ($1, $2, $3, 'user')
      RETURNING id, email, name, created_at
    `, [email, passwordHash, fullName]);

    const accountData = account.rows[0];

    // DO NOT create default license - customers start with 0 licenses
    // Licenses are only created after successful payment via Stripe webhooks

    // Generate JWT token
    const token = jwt.sign(
      { 
        accountId: accountData.id, 
        email: accountData.email,
        role: 'user'
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ 
      ok: true, 
      message: "Account created successfully",
      account: {
        id: accountData.id,
        email: accountData.email,
        name: accountData.name,
        companyName: companyName
      },
      licenseCount: 0, // New accounts start with 0 licenses
      token: token
    });

  } catch (error) {
    console.error("Account creation error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Internal server error during account creation" 
    });
  }
});

// Login endpoint
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  // Validation
  if (!email || !password) {
    return res.status(400).json({ 
      ok: false, 
      error: "Email and password are required" 
    });
  }

  try {
    // Get account with password hash
    const account = await pool.query(
      "SELECT id, email, password_hash, name, role FROM accounts WHERE email = $1",
      [email]
    );

    if (account.rows.length === 0) {
      return res.status(401).json({ 
        ok: false, 
        error: "Invalid email or password" 
      });
    }

    const accountData = account.rows[0];

    // Check if password hash exists (for accounts created before password implementation)
    if (!accountData.password_hash) {
      return res.status(401).json({ 
        ok: false, 
        error: "Account needs password setup. Please contact support." 
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, accountData.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ 
        ok: false, 
        error: "Invalid email or password" 
      });
    }

    // Get account licenses
    const licenses = await pool.query(
      "SELECT * FROM licenses WHERE account_id = $1 ORDER BY created_at DESC",
      [accountData.id]
    );

    // Generate JWT token
    const token = jwt.sign(
      { 
        accountId: accountData.id, 
        email: accountData.email,
        role: accountData.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ 
      ok: true, 
      message: "Login successful",
      account: {
        id: accountData.id,
        email: accountData.email,
        name: accountData.name,
        role: accountData.role
      },
      licenses: licenses.rows,
      token: token
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Internal server error during login" 
    });
  }
});

// Session-based login endpoint for dashboard
router.post("/login-session", async (req, res) => {
  const { email, password } = req.body || {};

  // Validation
  if (!email || !password) {
    return res.status(400).json({ 
      success: false, 
      error: "Email and password are required" 
    });
  }

  try {
    // Get account with password hash
    const account = await pool.query(
      "SELECT id, email, password_hash, name, status, subscription_status FROM accounts WHERE email = $1",
      [email]
    );

    if (account.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: "Invalid email or password" 
      });
    }

    const accountData = account.rows[0];

    // Check if account is active
    if (accountData.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        error: "Account is not active" 
      });
    }

    // Check if password hash exists
    if (!accountData.password_hash) {
      return res.status(401).json({ 
        success: false, 
        error: "Account needs password setup. Please contact support." 
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, accountData.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ 
        success: false, 
        error: "Invalid email or password" 
      });
    }

    // Create session
    const userAgent = req.headers['user-agent'] || '';
    const ipAddress = req.ip || req.connection.remoteAddress || '';
    
    const session = await createSession(accountData.id, userAgent, ipAddress);

    // Set session cookie
    res.cookie('session_id', session.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: accountData.id,
        email: accountData.email,
        name: accountData.name,
        subscriptionStatus: accountData.subscription_status
      },
      sessionId: session.sessionId
    });

  } catch (error) {
    console.error("Session login error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during login" 
    });
  }
});

// Session logout endpoint
router.post("/logout", async (req, res) => {
  try {
    const sessionId = req.cookies?.session_id;
    
    if (sessionId) {
      await invalidateSession(sessionId);
    }
    
    // Clear session cookie
    res.clearCookie('session_id');
    
    res.json({
      success: true,
      message: "Logout successful"
    });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during logout" 
    });
  }
});

// Token verification middleware
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ ok: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Get current user info (protected route)
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const account = await pool.query(
      "SELECT id, email, name, role, created_at FROM accounts WHERE id = $1",
      [req.user.accountId]
    );

    if (account.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Account not found" });
    }

    const licenses = await pool.query(
      "SELECT * FROM licenses WHERE account_id = $1 ORDER BY created_at DESC",
      [req.user.accountId]
    );

    res.json({ 
      ok: true, 
      account: account.rows[0],
      licenses: licenses.rows
    });

  } catch (error) {
    console.error("Get user info error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Internal server error" 
    });
  }
});

// Update existing account with password (temporary endpoint for migration)
router.post("/update-password", async (req, res) => {
  const { email, password, adminKey } = req.body || {};

  // Simple admin key check (in production, this should be more secure)
  if (adminKey !== "syncsure-admin-2025") {
    return res.status(403).json({ 
      ok: false, 
      error: "Unauthorized" 
    });
  }

  // Validation
  if (!email || !password) {
    return res.status(400).json({ 
      ok: false, 
      error: "Email and password are required" 
    });
  }

  try {
    // Check if account exists
    const existingAccount = await pool.query(
      "SELECT id, email, name, password_hash FROM accounts WHERE email = $1",
      [email]
    );

    if (existingAccount.rows.length === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: "Account not found" 
      });
    }

    const account = existingAccount.rows[0];

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Update account with password hash
    await pool.query(`
      UPDATE accounts 
      SET password_hash = $1, updated_at = now()
      WHERE email = $2
    `, [passwordHash, email]);

    res.json({ 
      ok: true, 
      message: `Password updated for account: ${account.email}`,
      account: {
        id: account.id,
        email: account.email,
        name: account.name,
        hadPreviousPassword: !!account.password_hash
      }
    });

  } catch (error) {
    console.error("Update password error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Internal server error during password update" 
    });
  }
});

export default router;


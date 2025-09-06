import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

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

    // Create default license for the account
    const licenseKey = `SYNC-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const license = await pool.query(`
      INSERT INTO licenses (account_id, license_key, max_devices, plan_type, price_per_device, company_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [accountData.id, licenseKey, 10, 'starter', 1.99, companyName || 'Default Company']);

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
      license: license.rows[0],
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

export default router;


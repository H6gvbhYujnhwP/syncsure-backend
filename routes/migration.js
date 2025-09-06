import express from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";

const router = express.Router();

// Database migration endpoint
router.post("/migrate-auth", async (req, res) => {
  const { adminKey } = req.body || {};

  // Simple admin key check
  if (adminKey !== "syncsure-admin-2025") {
    return res.status(403).json({ 
      ok: false, 
      error: "Unauthorized" 
    });
  }

  try {
    console.log("🔄 Starting authentication migration...");
    
    // Step 1: Add password_hash column if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE accounts 
        ADD COLUMN IF NOT EXISTS password_hash TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()
      `);
      console.log("✅ Added password_hash and updated_at columns");
    } catch (error) {
      console.log("ℹ️ Columns may already exist:", error.message);
    }

    // Step 2: Update existing accounts with default password
    const defaultPassword = "TestPassword123!";
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(defaultPassword, saltRounds);

    const updateResult = await pool.query(`
      UPDATE accounts 
      SET password_hash = $1, updated_at = now()
      WHERE password_hash IS NULL
      RETURNING email, name
    `, [passwordHash]);

    console.log(`✅ Updated ${updateResult.rows.length} accounts with default password`);

    // Step 3: Get summary of all accounts
    const allAccounts = await pool.query(`
      SELECT email, name, 
             CASE WHEN password_hash IS NOT NULL THEN 'Yes' ELSE 'No' END as has_password
      FROM accounts
      ORDER BY created_at DESC
    `);

    res.json({ 
      ok: true, 
      message: "Authentication migration completed successfully",
      summary: {
        totalAccounts: allAccounts.rows.length,
        accountsUpdated: updateResult.rows.length,
        defaultPassword: defaultPassword,
        accounts: allAccounts.rows
      }
    });

  } catch (error) {
    console.error("❌ Migration error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Migration failed: " + error.message 
    });
  }
});

// Test authentication endpoint
router.post("/test-auth", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ 
      ok: false, 
      error: "Email and password required" 
    });
  }

  try {
    // Get account
    const result = await pool.query(
      "SELECT id, email, name, password_hash FROM accounts WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ 
        ok: false, 
        error: "Account not found",
        debug: { email, accountExists: false }
      });
    }

    const account = result.rows[0];

    if (!account.password_hash) {
      return res.json({ 
        ok: false, 
        error: "Account has no password hash",
        debug: { email, hasPasswordHash: false }
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, account.password_hash);

    res.json({ 
      ok: passwordValid, 
      message: passwordValid ? "Authentication successful" : "Invalid password",
      debug: {
        email,
        accountExists: true,
        hasPasswordHash: true,
        passwordValid
      }
    });

  } catch (error) {
    console.error("Test auth error:", error);
    res.status(500).json({ 
      ok: false, 
      error: "Test failed: " + error.message 
    });
  }
});

export default router;


#!/usr/bin/env node

/**
 * Migration script to add missing account_id column to builds table
 * This fixes the "column 'account_id' does not exist" error
 */

import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log("Starting migration: Add account_id column to builds table");
    
    // Check if account_id column already exists
    const columnCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'builds' AND column_name = 'account_id'
    `);
    
    if (columnCheck.rows.length > 0) {
      console.log("✅ account_id column already exists in builds table");
      return;
    }
    
    // Begin transaction
    await client.query('BEGIN');
    
    console.log("📝 Adding account_id column to builds table...");
    
    // Add the account_id column
    await client.query(`
      ALTER TABLE builds 
      ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE
    `);
    
    console.log("📝 Populating account_id values from licenses table...");
    
    // Update existing builds with account_id from their associated license
    await client.query(`
      UPDATE builds 
      SET account_id = licenses.account_id 
      FROM licenses 
      WHERE builds.license_id = licenses.id
    `);
    
    console.log("📝 Making account_id column NOT NULL...");
    
    // Make the column NOT NULL after populating data
    await client.query(`
      ALTER TABLE builds 
      ALTER COLUMN account_id SET NOT NULL
    `);
    
    console.log("📝 Creating index on account_id column...");
    
    // Create index for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS builds_account_id_idx ON builds(account_id)
    `);
    
    // Commit transaction
    await client.query('COMMIT');
    
    console.log("✅ Migration completed successfully!");
    console.log("✅ builds table now has account_id column with proper foreign key constraint");
    console.log("✅ Index created for optimal query performance");
    
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    console.error("❌ Migration failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration()
    .then(() => {
      console.log("🎉 Migration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Migration script failed:", error);
      process.exit(1);
    });
}

export { runMigration };

import { pool } from "../db.js";

export async function migrateAddAccountId() {
  try {
    console.log("🔄 Running migration: Add account_id column to builds table");
    
    // Check if account_id column exists in builds table
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'builds' 
      AND column_name = 'account_id'
      AND table_schema = 'public'
    `);
    
    if (columnCheck.rows.length === 0) {
      console.log("📝 Adding account_id column to builds table...");
      
      // Add the account_id column with foreign key constraint
      await pool.query(`
        ALTER TABLE builds 
        ADD COLUMN account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
      `);
      
      console.log("✅ Added account_id column to builds table");
      
      // Add index for the new column
      await pool.query(`
        CREATE INDEX IF NOT EXISTS builds_account_id_idx ON builds(account_id)
      `);
      
      console.log("✅ Added index on builds.account_id");
      
      // Update existing builds to have account_id from their license
      const updateResult = await pool.query(`
        UPDATE builds 
        SET account_id = l.account_id 
        FROM licenses l 
        WHERE builds.license_id = l.id 
        AND builds.account_id IS NULL
      `);
      
      console.log(`✅ Updated ${updateResult.rowCount} existing builds with account_id`);
      
    } else {
      console.log("ℹ️  account_id column already exists in builds table");
    }
    
    // Verify the migration
    const verifyResult = await pool.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'builds' 
      AND column_name = 'account_id'
      AND table_schema = 'public'
    `);
    
    if (verifyResult.rows.length > 0) {
      const column = verifyResult.rows[0];
      console.log(`✅ Migration verified: account_id column exists (${column.data_type}, nullable: ${column.is_nullable})`);
    }
    
    return true;
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    
    // If the error is about NOT NULL constraint, it means we need to populate the column first
    if (error.message.includes("violates not-null constraint") || error.message.includes("column contains null values")) {
      console.log("🔄 Retrying migration with nullable column first...");
      
      try {
        // Add column as nullable first
        await pool.query(`
          ALTER TABLE builds 
          ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE
        `);
        
        // Update existing builds
        await pool.query(`
          UPDATE builds 
          SET account_id = l.account_id 
          FROM licenses l 
          WHERE builds.license_id = l.id 
          AND builds.account_id IS NULL
        `);
        
        // Make column NOT NULL
        await pool.query(`
          ALTER TABLE builds 
          ALTER COLUMN account_id SET NOT NULL
        `);
        
        // Add index
        await pool.query(`
          CREATE INDEX IF NOT EXISTS builds_account_id_idx ON builds(account_id)
        `);
        
        console.log("✅ Migration completed with nullable-first approach");
        return true;
      } catch (retryError) {
        console.error("❌ Retry migration also failed:", retryError.message);
        throw retryError;
      }
    }
    
    throw error;
  }
}

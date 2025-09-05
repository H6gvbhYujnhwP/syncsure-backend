import { pool } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function initializeDatabase() {
  try {
    console.log("🔄 Initializing database schema...");
    
    // Read the schema SQL file
    const schemaPath = path.join(__dirname, "../sql/schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    
    // Split the schema into individual statements
    const statements = schemaSql
      .split(";")
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);
    
    // Execute each statement
    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`📝 Executing: ${statement.substring(0, 50)}...`);
        await pool.query(statement);
      }
    }
    
    console.log("✅ Database schema initialized successfully");
    
    // Verify tables exist
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    const tables = result.rows.map(row => row.table_name);
    console.log("📋 Available tables:", tables.join(", "))
      
    // Run migration to add missing account_id column to builds table
    console.log("🔄 Running database migration for builds table...");
    
    // Check if account_id column exists in builds table
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'builds' AND column_name = 'account_id'
    `);
    
    if (columnCheck.rows.length === 0) {
      console.log("📝 Adding missing account_id column to builds table...");
      
      // Add the account_id column
      await pool.query(`
        ALTER TABLE builds 
        ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE
      `);
      
      // Update existing builds with account_id from their associated license
      await pool.query(`
        UPDATE builds 
        SET account_id = licenses.account_id 
        FROM licenses 
        WHERE builds.license_id = licenses.id
      `);
      
      // Make the column NOT NULL after populating data
      await pool.query(`
        ALTER TABLE builds 
        ALTER COLUMN account_id SET NOT NULL
      `);
      
      // Create index for performance
      await pool.query(`
        CREATE INDEX IF NOT EXISTS builds_account_id_idx ON builds(account_id)
      `);
      
      console.log("✅ Migration completed: account_id column added to builds table");
    } else {
      console.log("✅ account_id column already exists in builds table");
    }
    
    return true;
  } catch (error) {
    console.error("❌ Database initialization failed:", error.message);
    
    // If it's a "relation already exists" error, that's actually OK
    if (error.message.includes("already exists")) {
      console.log("ℹ️  Database schema already exists, continuing...");
      return true;
    }
    
    throw error;
  }
}

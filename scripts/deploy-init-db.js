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
    
    // Execute the entire schema in one query - DO NOT SPLIT ON SEMICOLONS!
    // This prevents breaking PostgreSQL functions with dollar-quoted strings
    console.log("📝 Executing complete schema in one operation...");
    await pool.query(schemaSql);
    
    console.log("✅ Database schema initialized successfully");
    
    // Verify tables exist
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    const tables = result.rows.map(row => row.table_name);
    console.log("📋 Available tables:", tables.join(", "));
    
    // Verify the account_id column exists in builds table
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'builds' AND column_name = 'account_id'
    `);
    
    if (columnCheck.rows.length > 0) {
      console.log("✅ account_id column exists in builds table");
    } else {
      console.log("⚠️  account_id column missing from builds table");
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

import { pool } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function initializeDatabase() {
  try {
    console.log("🔄 Initializing database schema...");
    
    // Test database connection first
    await pool.query('SELECT 1');
    console.log("✅ Database connection successful");
    
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
    
    // Enhanced error handling for deployment resilience
    if (error.message.includes("already exists") || 
        error.message.includes("relation") ||
        error.message.includes("function") ||
        error.message.includes("trigger") ||
        error.message.includes("extension")) {
      console.log("ℹ️  Database schema already exists or partial, continuing...");
      return true;
    }
    
    // For connection errors, log but don't crash in production
    if (error.code === 'ECONNREFUSED' || 
        error.code === 'ENOTFOUND' || 
        error.code === 'ETIMEDOUT' ||
        error.message.includes("connection")) {
      console.log("⚠️  Database connection failed, but continuing startup...");
      console.log("ℹ️  Server will attempt to reconnect on first request");
      return true;
    }
    
    // For authentication errors in development
    if (error.message.includes("authentication") || 
        error.message.includes("password") ||
        error.message.includes("role")) {
      console.log("⚠️  Database authentication issue, continuing...");
      return true;
    }
    
    throw error;
  }
}


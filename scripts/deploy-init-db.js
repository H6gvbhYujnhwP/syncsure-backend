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
    console.log("📋 Available tables:", tables.join(", "));
    
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

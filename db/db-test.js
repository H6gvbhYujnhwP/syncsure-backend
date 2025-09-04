// db/db-test.js
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});

async function testDbConnection() {
  try {
    const result = await pool.query("SELECT NOW() as now");
    console.log("✅ Database connected:", result.rows[0].now);
    process.exit(0);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }
}

testDbConnection();


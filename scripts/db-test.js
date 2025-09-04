import { pool } from "../db.js";

(async () => {
  try {
    const r = await pool.query("select now() as now");
    console.log("✅ DB connected at:", r.rows[0].now);
    process.exit(0);
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
    process.exit(1);
  }
})();


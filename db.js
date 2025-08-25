// db.js - Postgres via pg (works with Supabase or Replit Postgres)
// Use DATABASE_URL and SSL=on for hosted DBs
import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If your DB requires TLS (most hosted ones do)
  ssl: process.env.PGSSLMODE === 'require'
    ? { rejectUnauthorized: false }
    : false
});

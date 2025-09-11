/**
 * Test database connection with explicit SSL configuration
 */

import dotenv from 'dotenv';
import pkg from "pg";

// Load environment variables FIRST
dotenv.config();

const { Pool } = pkg;

async function testDatabaseSSL() {
  let pool;
  
  try {
    console.log('🧪 Testing Database Connection with SSL...');
    
    // Create pool with explicit SSL configuration
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });
    
    console.log('✅ Pool created');
    
    // Test connection
    console.log('🔄 Testing connection...');
    const client = await pool.connect();
    console.log('✅ Client connected');
    
    const result = await client.query('SELECT NOW() as now');
    console.log('✅ Query executed:', result.rows[0].now);
    
    client.release();
    console.log('✅ Client released');
    
    // Test table existence
    console.log('\n🔄 Testing table existence...');
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('✅ Tables found:', tables.rows.map(r => r.table_name).join(', '));
    
    console.log('\n🎉 Database connection successful!');
    
  } catch (error) {
    console.error('❌ Database test failed:', error.message);
    console.error('Error code:', error.code);
    console.error('Error details:', error);
  } finally {
    if (pool) {
      await pool.end();
      console.log('✅ Pool closed');
    }
  }
}

testDatabaseSSL();


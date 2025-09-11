/**
 * Test database connection and V9 schema
 */

import { pool } from './db.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testDatabase() {
  try {
    console.log('🧪 Testing V9 Database Components...');
    
    // Test 1: Database connection
    console.log('\n1. Testing database connection...');
    const dbResult = await pool.query('SELECT NOW() as now');
    console.log('✅ Database connected:', dbResult.rows[0].now);
    
    // Test 2: Check database tables
    console.log('\n2. Testing database tables...');
    
    const tables = ['accounts', 'subscriptions', 'licenses', 'webhook_events', 'builds', 'device_bindings'];
    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        console.log(`✅ Table ${table}: ${result.rows[0].count} rows`);
      } catch (error) {
        console.log(`❌ Table ${table}: ${error.message}`);
      }
    }
    
    // Test 3: Check for admin account
    console.log('\n3. Testing account lookup...');
    const accountResult = await pool.query(
      'SELECT * FROM accounts WHERE email = $1',
      ['admin@thegreenagents.com']
    );
    
    if (accountResult.rows.length > 0) {
      console.log('✅ Admin account exists:', accountResult.rows[0].email);
      console.log('   Account ID:', accountResult.rows[0].id);
      console.log('   Stripe Customer ID:', accountResult.rows[0].stripe_customer_id);
    } else {
      console.log('⚠️  Admin account does not exist');
    }
    
    // Test 4: Check subscriptions
    console.log('\n4. Testing subscriptions...');
    const subResult = await pool.query('SELECT * FROM subscriptions LIMIT 5');
    console.log(`✅ Found ${subResult.rows.length} subscriptions`);
    
    if (subResult.rows.length > 0) {
      console.log('   Sample subscription:', {
        id: subResult.rows[0].id,
        account_id: subResult.rows[0].account_id,
        stripe_subscription_id: subResult.rows[0].stripe_subscription_id,
        status: subResult.rows[0].status
      });
    }
    
    // Test 5: Check licenses
    console.log('\n5. Testing licenses...');
    const licenseResult = await pool.query('SELECT * FROM licenses LIMIT 5');
    console.log(`✅ Found ${licenseResult.rows.length} licenses`);
    
    if (licenseResult.rows.length > 0) {
      console.log('   Sample license:', {
        id: licenseResult.rows[0].id,
        account_id: licenseResult.rows[0].account_id,
        license_key: licenseResult.rows[0].license_key,
        status: licenseResult.rows[0].status
      });
    }
    
    console.log('\n🎉 Database tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

testDatabase();


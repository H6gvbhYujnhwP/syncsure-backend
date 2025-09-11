/**
 * Local test for V9 sync functionality
 */

import { pool } from './db.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function testV9Sync() {
  try {
    console.log('🧪 Testing V9 Sync Components...');
    
    // Test 1: Database connection
    console.log('\n1. Testing database connection...');
    const dbResult = await pool.query('SELECT NOW() as now');
    console.log('✅ Database connected:', dbResult.rows[0].now);
    
    // Test 2: Stripe API connection
    console.log('\n2. Testing Stripe API...');
    const customers = await stripe.customers.list({
      email: 'admin@thegreenagents.com',
      limit: 1
    });
    
    if (customers.data.length === 0) {
      console.log('❌ Customer not found in Stripe');
      return;
    }
    
    const customer = customers.data[0];
    console.log('✅ Customer found:', customer.email, customer.id);
    
    // Test 3: Get subscriptions
    console.log('\n3. Testing subscription retrieval...');
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all'
    });
    
    console.log(`✅ Found ${subscriptions.data.length} subscriptions`);
    
    const activeSubscription = subscriptions.data.find(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );
    
    if (!activeSubscription) {
      console.log('❌ No active subscription found');
      return;
    }
    
    console.log('✅ Active subscription:', activeSubscription.id, activeSubscription.status);
    console.log('   Quantity:', activeSubscription.items.data[0]?.quantity || 1);
    
    // Test 4: Check database tables
    console.log('\n4. Testing database tables...');
    
    const tables = ['accounts', 'subscriptions', 'licenses', 'webhook_events'];
    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        console.log(`✅ Table ${table}: ${result.rows[0].count} rows`);
      } catch (error) {
        console.log(`❌ Table ${table}: ${error.message}`);
      }
    }
    
    // Test 5: Check for existing account
    console.log('\n5. Testing account lookup...');
    const accountResult = await pool.query(
      'SELECT * FROM accounts WHERE stripe_customer_id = $1 OR email = $2',
      [customer.id, customer.email]
    );
    
    if (accountResult.rows.length > 0) {
      console.log('✅ Account exists:', accountResult.rows[0].email);
    } else {
      console.log('⚠️  Account does not exist, would be created');
    }
    
    console.log('\n🎉 All tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

testV9Sync();


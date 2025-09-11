/**
 * SyncSure V9 Stripe Routes - Debug Version
 * Enhanced error logging for troubleshooting
 */

import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';

const router = express.Router();

// Initialize Stripe with error handling
let stripe;
try {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('[V9-DEBUG] Stripe initialized successfully');
} catch (error) {
  console.error('[V9-DEBUG] Stripe initialization failed:', error.message);
}

// Test endpoint
router.get('/test', async (req, res) => {
  try {
    console.log('[V9-DEBUG] Test endpoint called');
    
    // Test database
    const dbResult = await pool.query('SELECT NOW() as now');
    console.log('[V9-DEBUG] Database test successful:', dbResult.rows[0].now);
    
    // Test Stripe
    if (!stripe) {
      throw new Error('Stripe not initialized');
    }
    
    const balance = await stripe.balance.retrieve();
    console.log('[V9-DEBUG] Stripe test successful');
    
    res.json({
      success: true,
      database: 'connected',
      stripe: 'connected',
      timestamp: dbResult.rows[0].now
    });
    
  } catch (error) {
    console.error('[V9-DEBUG] Test endpoint error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Simplified sync endpoint with detailed logging
router.post('/sync-customer', async (req, res) => {
  try {
    console.log('[V9-DEBUG] Sync customer endpoint called');
    console.log('[V9-DEBUG] Request body:', JSON.stringify(req.body));
    
    const { email } = req.body;
    
    if (!email) {
      console.log('[V9-DEBUG] No email provided');
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    console.log(`[V9-DEBUG] Syncing customer: ${email}`);

    // Test database connection first
    try {
      const dbTest = await pool.query('SELECT 1 as test');
      console.log('[V9-DEBUG] Database connection OK');
    } catch (dbError) {
      console.error('[V9-DEBUG] Database connection failed:', dbError.message);
      throw new Error(`Database connection failed: ${dbError.message}`);
    }

    // Test Stripe connection
    if (!stripe) {
      throw new Error('Stripe not initialized - check STRIPE_SECRET_KEY');
    }

    console.log('[V9-DEBUG] Searching for customer in Stripe...');
    
    // Find customer in Stripe
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    console.log(`[V9-DEBUG] Found ${customers.data.length} customers`);

    if (customers.data.length === 0) {
      console.log('[V9-DEBUG] Customer not found in Stripe');
      return res.status(404).json({
        success: false,
        error: 'Customer not found in Stripe'
      });
    }

    const customer = customers.data[0];
    console.log(`[V9-DEBUG] Customer found: ${customer.email} (${customer.id})`);

    // Get active subscriptions
    console.log('[V9-DEBUG] Getting subscriptions...');
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all'
    });

    console.log(`[V9-DEBUG] Found ${subscriptions.data.length} subscriptions`);

    const activeSubscription = subscriptions.data.find(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );

    if (!activeSubscription) {
      console.log('[V9-DEBUG] No active subscription found');
      return res.status(404).json({
        success: false,
        error: 'No active subscription found',
        subscriptions: subscriptions.data.map(s => ({
          id: s.id,
          status: s.status
        }))
      });
    }

    console.log(`[V9-DEBUG] Active subscription: ${activeSubscription.id} (${activeSubscription.status})`);
    
    const quantity = activeSubscription.items.data[0]?.quantity || 1;
    console.log(`[V9-DEBUG] Subscription quantity: ${quantity}`);

    // For now, just return success without database operations
    res.json({
      success: true,
      message: 'Customer sync test successful',
      customer: {
        email: customer.email,
        id: customer.id,
        subscriptionId: activeSubscription.id,
        status: activeSubscription.status,
        quantity: quantity
      }
    });

  } catch (error) {
    console.error('[V9-DEBUG] Customer sync error:', error.message);
    console.error('[V9-DEBUG] Stack trace:', error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Check server logs for full error details'
    });
  }
});

export default router;


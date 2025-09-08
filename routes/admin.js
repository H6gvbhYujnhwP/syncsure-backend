// Admin routes for SyncSure management
import express from "express";
import { pool } from "../db.js";
import { sendWelcomeEmail, sendBuildCompleteEmail } from "../services/email.js";

const router = express.Router();

// Fix builds for customers with active licenses but no builds
router.post("/fix-builds", async (req, res) => {
  try {
    console.log('🔍 Checking for customers with active licenses but no builds...');
    
    // Find customers with licenses but no builds
    const query = `
      SELECT 
        l.id as license_id,
        l.account_id,
        l.license_key,
        l.max_devices,
        a.email,
        COUNT(b.id) as build_count
      FROM licenses l
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN builds b ON b.license_id = l.id
      GROUP BY l.id, l.account_id, l.license_key, l.max_devices, a.email
      HAVING COUNT(b.id) = 0
    `;
    
    const { rows } = await pool.query(query);
    
    if (rows.length === 0) {
      return res.json({
        success: true,
        message: 'All customers with licenses already have builds',
        buildsCreated: 0
      });
    }
    
    console.log(`🏗️ Found ${rows.length} customers needing builds`);
    const buildsCreated = [];
    
    for (const customer of rows) {
      console.log(`  - ${customer.email} (License: ${customer.license_key})`);
      
      // Create build for this customer
      const tag = `license-${customer.license_id}-${Date.now()}`;
      
      const buildQuery = `
        INSERT INTO builds (license_id, account_id, status, tag, created_at, updated_at)
        VALUES ($1, $2, 'queued', $3, NOW(), NOW())
        RETURNING id, tag
      `;
      
      const buildResult = await pool.query(buildQuery, [
        customer.license_id,
        customer.account_id,
        tag
      ]);
      
      const build = buildResult.rows[0];
      console.log(`    ✅ Build created: ${build.tag} (ID: ${build.id})`);
      
      buildsCreated.push({
        email: customer.email,
        licenseKey: customer.license_key,
        buildId: build.id,
        buildTag: build.tag
      });
      
      // Send welcome email if not already sent
      try {
        await sendWelcomeEmail({
          to: customer.email,
          customerName: customer.email.split('@')[0],
          licenseKey: customer.license_key,
          downloadUrl: `${process.env.FRONTEND_ORIGIN || 'https://syncsure.cloud'}/dashboard`,
          maxDevices: customer.max_devices
        });
        console.log(`    📧 Welcome email sent to ${customer.email}`);
      } catch (emailError) {
        console.error(`    ❌ Failed to send welcome email to ${customer.email}:`, emailError.message);
      }
    }
    
    res.json({
      success: true,
      message: `Successfully created ${buildsCreated.length} builds`,
      buildsCreated
    });
    
  } catch (error) {
    console.error('❌ Error fixing builds:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test email system
router.post("/test-email", async (req, res) => {
  try {
    const { email, type = 'welcome' } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email address required'
      });
    }
    
    let result;
    
    switch (type) {
      case 'welcome':
        result = await sendWelcomeEmail({
          to: email,
          customerName: 'Test Customer',
          licenseKey: 'TEST-1234-5678-9ABC',
          downloadUrl: 'https://syncsure.cloud/dashboard',
          maxDevices: 50
        });
        break;
        
      case 'build':
        result = await sendBuildCompleteEmail({
          to: email,
          customerName: 'Test Customer',
          licenseKey: 'TEST-1234-5678-9ABC',
          downloadUrl: 'https://syncsure.cloud/dashboard',
          buildTag: 'test-build-123'
        });
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid email type. Use: welcome, build'
        });
    }
    
    res.json({
      success: true,
      message: `${type} email sent successfully`,
      result
    });
    
  } catch (error) {
    console.error('❌ Error sending test email:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get system status
router.get("/status", async (req, res) => {
  try {
    // Check database connection
    const dbResult = await pool.query('SELECT NOW() as current_time');
    
    // Check email configuration
    const emailConfigured = !!process.env.RESEND_API_KEY;
    
    // Get counts
    const accountsResult = await pool.query('SELECT COUNT(*) as count FROM accounts');
    const licensesResult = await pool.query('SELECT COUNT(*) as count FROM licenses');
    const buildsResult = await pool.query('SELECT COUNT(*) as count FROM builds');
    
    res.json({
      success: true,
      status: {
        database: 'connected',
        email: emailConfigured ? 'configured' : 'not configured',
        timestamp: dbResult.rows[0].current_time,
        counts: {
          accounts: parseInt(accountsResult.rows[0].count),
          licenses: parseInt(licensesResult.rows[0].count),
          builds: parseInt(buildsResult.rows[0].count)
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Force retry building builds (reset to queued)
router.post("/force-retry-builds", async (req, res) => {
  try {
    console.log('🔄 Force retrying building builds...');
    
    // Find building builds
    const query = `
      SELECT 
        b.id,
        b.tag,
        b.license_id,
        b.account_id,
        l.license_key,
        a.email
      FROM builds b
      JOIN licenses l ON l.id = b.license_id
      JOIN accounts a ON a.id = l.account_id
      WHERE b.status = 'building'
      ORDER BY b.created_at DESC
    `;
    
    const { rows } = await pool.query(query);
    
    if (rows.length === 0) {
      return res.json({
        success: true,
        message: 'No building builds to force retry',
        retriedBuilds: 0
      });
    }
    
    console.log(`🔄 Found ${rows.length} building builds to force retry`);
    const retriedBuilds = [];
    
    for (const build of rows) {
      console.log(`  - Force retrying build ${build.id} (${build.tag}) for ${build.email}`);
      
      // Reset build to queued status
      await pool.query(
        'UPDATE builds SET status = $1, updated_at = NOW() WHERE id = $2',
        ['queued', build.id]
      );
      
      retriedBuilds.push({
        buildId: build.id,
        tag: build.tag,
        email: build.email,
        licenseKey: build.license_key
      });
    }
    
    res.json({
      success: true,
      message: `Successfully queued ${retriedBuilds.length} building builds for force retry`,
      retriedBuilds
    });
    
  } catch (error) {
    console.error('❌ Error force retrying builds:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Retry failed builds
router.post("/retry-failed-builds", async (req, res) => {
  try {
    console.log('🔄 Retrying failed builds...');
    
    // Find failed builds
    const query = `
      SELECT 
        b.id,
        b.tag,
        b.license_id,
        b.account_id,
        l.license_key,
        a.email
      FROM builds b
      JOIN licenses l ON l.id = b.license_id
      JOIN accounts a ON a.id = l.account_id
      WHERE b.status = 'failed'
      ORDER BY b.created_at DESC
    `;
    
    const { rows } = await pool.query(query);
    
    if (rows.length === 0) {
      return res.json({
        success: true,
        message: 'No failed builds to retry',
        retriedBuilds: 0
      });
    }
    
    console.log(`🔄 Found ${rows.length} failed builds to retry`);
    const retriedBuilds = [];
    
    for (const build of rows) {
      console.log(`  - Retrying build ${build.id} (${build.tag}) for ${build.email}`);
      
      // Reset build to queued status
      await pool.query(
        'UPDATE builds SET status = $1, updated_at = NOW() WHERE id = $2',
        ['queued', build.id]
      );
      
      retriedBuilds.push({
        buildId: build.id,
        tag: build.tag,
        email: build.email,
        licenseKey: build.license_key
      });
    }
    
    res.json({
      success: true,
      message: `Successfully queued ${retriedBuilds.length} failed builds for retry`,
      retriedBuilds
    });
    
  } catch (error) {
    console.error('❌ Error retrying failed builds:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get build status and logs
router.get("/builds/:email", async (req, res) => {
  try {
    const { email } = req.params;
    
    const query = `
      SELECT 
        b.id,
        b.status,
        b.tag,
        b.release_url,
        b.asset_name,
        b.created_at,
        b.updated_at,
        l.license_key,
        a.email
      FROM builds b
      JOIN licenses l ON l.id = b.license_id
      JOIN accounts a ON a.id = l.account_id
      WHERE a.email = $1
      ORDER BY b.created_at DESC
    `;
    
    const { rows } = await pool.query(query, [email]);
    
    res.json({
      success: true,
      builds: rows
    });
    
  } catch (error) {
    console.error('❌ Error fetching builds:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;


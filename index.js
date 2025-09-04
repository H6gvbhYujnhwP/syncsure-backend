import express from 'express';
import cors from 'cors';
import pg from 'pg';
import rateLimit from 'express-rate-limit';
// Import email service
import emailService from './email-service.js';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 10000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// CORS - Allow all origins for tool access (tools don't have CORS restrictions)
app.use(cors({
  origin: [
    'http://localhost:3000',                    // Local development
    'https://sync-sure-agents5.replit.app',    // Replit development URL
    'https://syncsure.cloud',                  // Custom domain
    'https://syncsure-frontend.onrender.com'   // Alternative frontend
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Rate limiting for critical endpoints
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2, // 2 requests per minute per device
  keyGenerator: (req) => `${req.ip}-${req.body.deviceHash}`,
  message: 'Too many heartbeat requests from this device'
});

const deviceManagementLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 device management requests per minute
  message: 'Too many device management requests'
});

// NEW: Email rate limiting
const emailLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 email requests per minute
  message: 'Too many email requests'
});

// Event normalization catalog
const eventCatalog = {
  // Sync status events
  'sync_status_check': { status: 'ok', eventType: 'sync_status_check' },
  'sync_healthy': { status: 'ok', eventType: 'sync_status_check' },
  'sync_warning': { status: 'warn', eventType: 'sync_status_check' },
  
  // Pause events
  'sync_paused': { status: 'warn', eventType: 'sync_paused' },
  'onedrive_paused': { status: 'warn', eventType: 'sync_paused' },
  'pause_detected': { status: 'warn', eventType: 'sync_paused' },
  
  // Error events
  'sync_error': { status: 'error', eventType: 'sync_error' },
  'sync_failed': { status: 'error', eventType: 'sync_error' },
  'onedrive_error': { status: 'error', eventType: 'sync_error' },
  
  // Process events
  'process_running': { status: 'ok', eventType: 'sync_status_check' },
  'process_healthy': { status: 'ok', eventType: 'sync_status_check' },
  'process_warning': { status: 'warn', eventType: 'sync_status_check' },
  'process_error': { status: 'error', eventType: 'sync_error' },
  
  // Auth events
  'auth_ok': { status: 'ok', eventType: 'sync_status_check' },
  'auth_warning': { status: 'warn', eventType: 'sync_status_check' },
  'auth_error': { status: 'error', eventType: 'sync_error' },
  
  // Storage events
  'storage_ok': { status: 'ok', eventType: 'sync_status_check' },
  'storage_warning': { status: 'warn', eventType: 'sync_status_check' },
  'storage_error': { status: 'error', eventType: 'sync_error' },
  
  // Performance events
  'performance_ok': { status: 'ok', eventType: 'sync_status_check' },
  'performance_warning': { status: 'warn', eventType: 'sync_status_check' },
  'performance_error': { status: 'error', eventType: 'sync_error' },
  
  // Connectivity events
  'connectivity_ok': { status: 'ok', eventType: 'sync_status_check' },
  'connectivity_warning': { status: 'warn', eventType: 'sync_status_check' },
  'connectivity_error': { status: 'error', eventType: 'sync_error' },
  
  // Generic events
  'ok': { status: 'ok', eventType: 'sync_status_check' },
  'warn': { status: 'warn', eventType: 'sync_status_check' },
  'warning': { status: 'warn', eventType: 'sync_status_check' },
  'error': { status: 'error', eventType: 'sync_error' },
  'offline': { status: 'error', eventType: 'sync_error' },
  'asleep': { status: 'warn', eventType: 'sync_status_check' }
};

// Normalize event function
function normalizeEvent(status, eventType) {
  // First try exact eventType match
  if (eventCatalog[eventType]) {
    return eventCatalog[eventType];
  }
  
  // Then try status match
  if (eventCatalog[status]) {
    return eventCatalog[status];
  }
  
  // Default fallback based on status
  switch (status) {
    case 'ok':
      return { status: 'ok', eventType: 'sync_status_check' };
    case 'warn':
    case 'warning':
      return { status: 'warn', eventType: 'sync_status_check' };
    case 'error':
      return { status: 'error', eventType: 'sync_error' };
    case 'asleep':
    case 'offline':
      return { status: 'warn', eventType: 'sync_status_check' };
    default:
      return { status: 'ok', eventType: 'sync_status_check' };
  }
}

// NEW: Device offline monitoring
let deviceOfflineChecks = new Map(); // Track offline check timers

function scheduleOfflineCheck(licenseId, deviceHash, customerEmail, customerName, deviceName) {
  const checkKey = `${licenseId}-${deviceHash}`;
  
  // Clear existing timer if any
  if (deviceOfflineChecks.has(checkKey)) {
    clearTimeout(deviceOfflineChecks.get(checkKey));
  }
  
  // Schedule offline check for 24 hours
  const timer = setTimeout(async () => {
    try {
      // Check if device is still offline
      const result = await pool.query(
        'SELECT last_seen FROM license_bindings WHERE license_id = $1 AND device_hash = $2 AND status = $3',
        [licenseId, deviceHash, 'active']
      );
      
      if (result.rows.length > 0) {
        const lastSeen = new Date(result.rows[0].last_seen);
        const now = new Date();
        const hoursOffline = (now - lastSeen) / (1000 * 60 * 60);
        
        // If device has been offline for more than 24 hours, send alert
        if (hoursOffline >= 24) {
          console.log(`📧 Sending offline alert for device ${deviceName} (${deviceHash})`);
          await emailService.sendDeviceAlertEmail(
            customerEmail,
            customerName,
            deviceName || deviceHash,
            'Device Offline',
            `${Math.floor(hoursOffline)} hours ago`
          );
        }
      }
    } catch (error) {
      console.error('Error in offline check:', error);
    } finally {
      deviceOfflineChecks.delete(checkKey);
    }
  }, 24 * 60 * 60 * 1000); // 24 hours
  
  deviceOfflineChecks.set(checkKey, timer);
}

// Database schema setup - Enhanced schema with device management logging
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up heartbeat processing database schema...');
    
    // Licenses table - Basic license validation
    // UPDATED: Changed default from 5 to 1 to match new pricing model
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        max_devices INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        customer_email VARCHAR,
        customer_name VARCHAR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);

    // License bindings table - Device tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash TEXT NOT NULL,
        device_name VARCHAR DEFAULT NULL,
        status VARCHAR DEFAULT 'active',
        bound_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        last_seen TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        UNIQUE(license_id, device_hash)
      )
    `);

    // Heartbeats table - Status history
    await client.query(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        error_detail JSONB,
        timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);

    // Device management log table - NEW for audit trail
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_management_log (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL,
        device_hash VARCHAR NOT NULL,
        action VARCHAR NOT NULL,
        details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);

    // NEW: Email log table for tracking sent emails
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_log (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID,
        customer_email VARCHAR NOT NULL,
        email_type VARCHAR NOT NULL,
        subject VARCHAR,
        message_id VARCHAR,
        status VARCHAR DEFAULT 'sent',
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);

    // Performance indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_license_time 
      ON heartbeats(license_id, created_at DESC)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_device_time 
      ON heartbeats(device_hash, created_at DESC)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_license_bindings_device 
      ON license_bindings(device_hash)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_license_bindings_license 
      ON license_bindings(license_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_licenses_key 
      ON licenses(key)
    `);

    // NEW: Index for device management log
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_management_log_license 
      ON device_management_log(license_id, created_at DESC)
    `);

    // NEW: Index for email log
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_log_license 
      ON email_log(license_id, created_at DESC)
    `);

    // Add customer_name column if it doesn't exist
    await client.query(`
      ALTER TABLE licenses 
      ADD COLUMN IF NOT EXISTS customer_name VARCHAR
    `);

    // Create test license if it doesn't exist - UPDATED for new pricing model
    const testLicenseExists = await client.query('SELECT id FROM licenses WHERE key = $1', ['SYNC-TEST-123']);
    if (testLicenseExists.rowCount === 0) {
      await client.query(
        'INSERT INTO licenses (key, max_devices, status, customer_email, customer_name) VALUES ($1, $2, $3, $4, $5)',
        ['SYNC-TEST-123', 25, 'active', 'test@syncsure.com', 'Test User'] // 25 devices for testing
      );
      console.log('✅ Test license created: SYNC-TEST-123 (25 devices)');
    }

    console.log('✅ Heartbeat processing database schema setup complete!');
  } catch (error) {
    console.error('❌ Error during schema setup:', error);
  } finally {
    client.release();
  }
}

// Initialize database on startup
ensureSchema();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'syncsure-heartbeat-api',
    version: '3.3.0', // Updated version for new pricing model
    features: ['heartbeat-processing', 'device-management', 'manual-removal', 'email-notifications', 'new-pricing-model'],
    pricing_model: {
      starter: { devices: '1-50', price_per_device: '£1.99' },
      business: { devices: '51-500', price_per_device: '£1.49' },
      enterprise: { devices: '500+', price_per_device: '£0.99' }
    },
    timestamp: new Date().toISOString() 
  });
});

// NEW: Email service endpoints

// Send welcome email (called from Replit after user registration)
app.post('/api/email/welcome', emailLimiter, async (req, res) => {
  try {
    const { customerEmail, customerName } = req.body;
    
    if (!customerEmail || !customerName) {
      return res.status(400).json({ error: 'Missing required fields: customerEmail, customerName' });
    }
    
    const result = await emailService.sendWelcomeEmail(customerEmail, customerName);
    
    // Log email attempt
    await pool.query(
      'INSERT INTO email_log (customer_email, email_type, subject, message_id, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
      [customerEmail, 'welcome', 'Welcome to SyncSure', result.messageId || null, result.success ? 'sent' : 'failed', result.error || null]
    );
    
    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Welcome email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send license delivery email (called from Replit after license purchase)
app.post('/api/email/license-delivery', emailLimiter, async (req, res) => {
  try {
    const { customerEmail, customerName, licenseKey, maxDevices } = req.body;
    
    if (!customerEmail || !customerName || !licenseKey) {
      return res.status(400).json({ error: 'Missing required fields: customerEmail, customerName, licenseKey' });
    }
    
    const result = await emailService.sendLicenseDeliveryEmail(customerEmail, customerName, licenseKey, maxDevices);
    
    // Get license ID for logging
    const licenseResult = await pool.query('SELECT id FROM licenses WHERE key = $1', [licenseKey]);
    const licenseId = licenseResult.rows[0]?.id || null;
    
    // Log email attempt
    await pool.query(
      'INSERT INTO email_log (license_id, customer_email, email_type, subject, message_id, status, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [licenseId, customerEmail, 'license_delivery', 'Your SyncSure License Key', result.messageId || null, result.success ? 'sent' : 'failed', result.error || null]
    );
    
    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('License delivery email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send support email
app.post('/api/email/support', emailLimiter, async (req, res) => {
  try {
    const { customerEmail, customerName, supportQuery } = req.body;
    
    if (!customerEmail || !customerName || !supportQuery) {
      return res.status(400).json({ error: 'Missing required fields: customerEmail, customerName, supportQuery' });
    }
    
    const result = await emailService.sendSupportEmail(customerEmail, customerName, supportQuery);
    
    // Log email attempt
    await pool.query(
      'INSERT INTO email_log (customer_email, email_type, subject, message_id, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
      [customerEmail, 'support', `Support Request - ${result.ticketId}`, result.customerMessageId || null, result.success ? 'sent' : 'failed', result.error || null]
    );
    
    if (result.success) {
      res.json({ success: true, ticketId: result.ticketId, messageId: result.customerMessageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Support email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send billing confirmation email (called from Replit after Stripe webhook)
app.post('/api/email/billing', emailLimiter, async (req, res) => {
  try {
    const { customerEmail, customerName, amount, invoiceId, nextBillingDate } = req.body;
    
    if (!customerEmail || !customerName || !amount || !invoiceId) {
      return res.status(400).json({ error: 'Missing required fields: customerEmail, customerName, amount, invoiceId' });
    }
    
    const result = await emailService.sendBillingEmail(customerEmail, customerName, amount, invoiceId, nextBillingDate);
    
    // Log email attempt
    await pool.query(
      'INSERT INTO email_log (customer_email, email_type, subject, message_id, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
      [customerEmail, 'billing', 'Payment Confirmation', result.messageId || null, result.success ? 'sent' : 'failed', result.error || null]
    );
    
    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Billing email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Heartbeat endpoint - Core functionality
app.post('/api/heartbeat', heartbeatLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { licenseKey, deviceHash, status, eventType, message, deviceName } = req.body;
    
    // Validate required fields
    if (!licenseKey || !deviceHash || !status) {
      return res.status(400).json({ 
        error: 'Missing required fields: licenseKey, deviceHash, status' 
      });
    }

    // Normalize the event
    const normalizedEvent = normalizeEvent(status, eventType);
    const finalStatus = normalizedEvent.status;
    const finalEventType = normalizedEvent.eventType;
    const finalMessage = message || `Device ${deviceHash} status: ${finalStatus}`;

    // Get license info
    const licenseResult = await pool.query(
      'SELECT id, max_devices, status, customer_email, customer_name FROM licenses WHERE key = $1',
      [licenseKey]
    );

    if (licenseResult.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid license key' });
    }

    const license = licenseResult.rows[0];
    if (license.status !== 'active') {
      return res.status(403).json({ error: 'License is not active' });
    }

    // Check device binding and seat availability
    const bindingResult = await pool.query(
      'SELECT id, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [license.id, deviceHash]
    );

    let deviceBinding;
    if (bindingResult.rowCount === 0) {
      // New device - check seat availability
      const activeDevicesResult = await pool.query(
        'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status = $2',
        [license.id, 'active']
      );

      const activeDeviceCount = parseInt(activeDevicesResult.rows[0].count);
      if (activeDeviceCount >= license.max_devices) {
        return res.status(403).json({ 
          error: 'License seat limit exceeded',
          maxDevices: license.max_devices,
          currentDevices: activeDeviceCount
        });
      }

      // Bind new device
      const newBindingResult = await pool.query(
        'INSERT INTO license_bindings (license_id, device_hash, device_name, status, last_seen) VALUES ($1, $2, $3, $4, $5) RETURNING id, status',
        [license.id, deviceHash, deviceName || null, 'active', new Date()]
      );
      deviceBinding = newBindingResult.rows[0];
      
      console.log(`✅ New device bound: ${deviceHash} to license ${licenseKey} (${activeDeviceCount + 1}/${license.max_devices})`);
    } else {
      deviceBinding = bindingResult.rows[0];
      
      // Update last seen time
      await pool.query(
        'UPDATE license_bindings SET last_seen = $1, updated_at = $2 WHERE license_id = $3 AND device_hash = $4',
        [new Date(), new Date(), license.id, deviceHash]
      );
    }

    // Record heartbeat
    await pool.query(
      'INSERT INTO heartbeats (license_id, device_hash, status, event_type, message, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
      [license.id, deviceHash, finalStatus, finalEventType, finalMessage, new Date()]
    );

    // Schedule offline check for this device
    if (license.customer_email && license.customer_name) {
      scheduleOfflineCheck(license.id, deviceHash, license.customer_email, license.customer_name, deviceName);
    }

    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      deviceBinding: deviceBinding.status,
      normalizedStatus: finalStatus,
      normalizedEventType: finalEventType,
      processingTimeMs: processingTime
    });

  } catch (error) {
    console.error('Heartbeat processing error:', error);
    const processingTime = Date.now() - startTime;
    
    res.status(500).json({ 
      error: 'Internal server error',
      processingTimeMs: processingTime
    });
  }
});

// License validation endpoint
app.post('/api/validate-license', async (req, res) => {
  try {
    const { licenseKey } = req.body;
    
    if (!licenseKey) {
      return res.status(400).json({ error: 'License key is required' });
    }

    const result = await pool.query(
      'SELECT id, max_devices, status, customer_email, customer_name FROM licenses WHERE key = $1',
      [licenseKey]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = result.rows[0];
    
    // Get current device count
    const deviceCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status = $2',
      [license.id, 'active']
    );

    const currentDevices = parseInt(deviceCountResult.rows[0].count);

    res.json({
      valid: license.status === 'active',
      licenseId: license.id,
      maxDevices: license.max_devices,
      currentDevices: currentDevices,
      availableSeats: license.max_devices - currentDevices,
      status: license.status,
      customerEmail: license.customer_email,
      customerName: license.customer_name
    });

  } catch (error) {
    console.error('License validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Device management endpoints

// Get devices for a license
app.get('/api/license/:licenseKey/devices', async (req, res) => {
  try {
    const { licenseKey } = req.params;
    
    const licenseResult = await pool.query(
      'SELECT id, max_devices FROM licenses WHERE key = $1 AND status = $2',
      [licenseKey, 'active']
    );

    if (licenseResult.rowCount === 0) {
      return res.status(404).json({ error: 'License not found or inactive' });
    }

    const license = licenseResult.rows[0];
    
    const devicesResult = await pool.query(`
      SELECT 
        device_hash,
        device_name,
        status,
        bound_at,
        last_seen,
        EXTRACT(EPOCH FROM (now() - last_seen))/3600 as hours_since_last_seen
      FROM license_bindings 
      WHERE license_id = $1 
      ORDER BY last_seen DESC
    `, [license.id]);

    res.json({
      licenseKey,
      maxDevices: license.max_devices,
      devices: devicesResult.rows
    });

  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove device manually (with 14-day grace period)
app.delete('/api/license/:licenseKey/device/:deviceHash', deviceManagementLimiter, async (req, res) => {
  try {
    const { licenseKey, deviceHash } = req.params;
    
    const licenseResult = await pool.query(
      'SELECT id FROM licenses WHERE key = $1 AND status = $2',
      [licenseKey, 'active']
    );

    if (licenseResult.rowCount === 0) {
      return res.status(404).json({ error: 'License not found or inactive' });
    }

    const licenseId = licenseResult.rows[0].id;
    
    // Check if device exists
    const deviceResult = await pool.query(
      'SELECT id, device_name, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [licenseId, deviceHash]
    );

    if (deviceResult.rowCount === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = deviceResult.rows[0];
    
    // Mark device as removed (soft delete with 14-day grace period)
    await pool.query(
      'UPDATE license_bindings SET status = $1, updated_at = $2 WHERE license_id = $3 AND device_hash = $4',
      ['removed', new Date(), licenseId, deviceHash]
    );

    // Log the removal action
    await pool.query(
      'INSERT INTO device_management_log (license_id, device_hash, action, details) VALUES ($1, $2, $3, $4)',
      [licenseId, deviceHash, 'manual_removal', `Device ${device.device_name || deviceHash} manually removed via API`]
    );

    // Schedule permanent deletion after 14 days
    setTimeout(async () => {
      try {
        await pool.query(
          'DELETE FROM license_bindings WHERE license_id = $1 AND device_hash = $2 AND status = $3',
          [licenseId, deviceHash, 'removed']
        );
        
        await pool.query(
          'INSERT INTO device_management_log (license_id, device_hash, action, details) VALUES ($1, $2, $3, $4)',
          [licenseId, deviceHash, 'permanent_deletion', `Device ${device.device_name || deviceHash} permanently deleted after 14-day grace period`]
        );
        
        console.log(`🗑️ Device ${deviceHash} permanently deleted after 14-day grace period`);
      } catch (error) {
        console.error('Error in permanent device deletion:', error);
      }
    }, 14 * 24 * 60 * 60 * 1000); // 14 days

    console.log(`🔄 Device ${deviceHash} marked for removal (14-day grace period)`);

    res.json({
      success: true,
      message: 'Device marked for removal',
      gracePeriodDays: 14,
      deviceHash,
      deviceName: device.device_name
    });

  } catch (error) {
    console.error('Device removal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get device management audit log
app.get('/api/license/:licenseKey/audit-log', async (req, res) => {
  try {
    const { licenseKey } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const licenseResult = await pool.query(
      'SELECT id FROM licenses WHERE key = $1',
      [licenseKey]
    );

    if (licenseResult.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    const licenseId = licenseResult.rows[0].id;
    
    const logResult = await pool.query(`
      SELECT 
        device_hash,
        action,
        details,
        created_at
      FROM device_management_log 
      WHERE license_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `, [licenseId, limit]);

    res.json({
      licenseKey,
      auditLog: logResult.rows
    });

  } catch (error) {
    console.error('Audit log error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// UPSERT endpoint for Replit integration - UPDATED for new pricing model
app.post('/api/upsert-license', async (req, res) => {
  try {
    const { licenseKey, maxDevices, customerEmail, customerName, status = 'active' } = req.body;
    
    if (!licenseKey || !maxDevices || !customerEmail) {
      return res.status(400).json({ 
        error: 'Missing required fields: licenseKey, maxDevices, customerEmail' 
      });
    }

    // Validate maxDevices is a positive integer
    const deviceCount = parseInt(maxDevices);
    if (isNaN(deviceCount) || deviceCount < 1) {
      return res.status(400).json({ 
        error: 'maxDevices must be a positive integer' 
      });
    }

    // Determine pricing tier based on device count
    let pricingTier;
    if (deviceCount >= 1 && deviceCount <= 50) {
      pricingTier = 'starter';
    } else if (deviceCount >= 51 && deviceCount <= 500) {
      pricingTier = 'business';
    } else if (deviceCount >= 501) {
      pricingTier = 'enterprise';
    } else {
      return res.status(400).json({ 
        error: 'Invalid device count. Must be at least 1.' 
      });
    }

    const result = await pool.query(`
      INSERT INTO licenses (key, max_devices, status, customer_email, customer_name, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (key) 
      DO UPDATE SET 
        max_devices = EXCLUDED.max_devices,
        status = EXCLUDED.status,
        customer_email = EXCLUDED.customer_email,
        customer_name = EXCLUDED.customer_name,
        updated_at = now()
      RETURNING id, key, max_devices, status, customer_email, customer_name, created_at, updated_at
    `, [licenseKey, deviceCount, status, customerEmail, customerName || null]);

    const license = result.rows[0];
    
    // Get current device count
    const deviceCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status = $2',
      [license.id, 'active']
    );

    const currentDevices = parseInt(deviceCountResult.rows[0].count);

    console.log(`✅ License upserted: ${licenseKey} (${deviceCount} devices, ${pricingTier} tier)`);

    res.json({
      success: true,
      license: {
        id: license.id,
        key: license.key,
        maxDevices: license.max_devices,
        currentDevices: currentDevices,
        availableSeats: license.max_devices - currentDevices,
        status: license.status,
        customerEmail: license.customer_email,
        customerName: license.customer_name,
        pricingTier: pricingTier,
        createdAt: license.created_at,
        updatedAt: license.updated_at
      }
    });

  } catch (error) {
    console.error('License upsert error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get license statistics
app.get('/api/license/:licenseKey/stats', async (req, res) => {
  try {
    const { licenseKey } = req.params;
    
    const licenseResult = await pool.query(
      'SELECT id, max_devices, status, customer_email, customer_name FROM licenses WHERE key = $1',
      [licenseKey]
    );

    if (licenseResult.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    const license = licenseResult.rows[0];
    
    // Get device statistics
    const deviceStatsResult = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM license_bindings 
      WHERE license_id = $1 
      GROUP BY status
    `, [license.id]);

    const deviceStats = {};
    deviceStatsResult.rows.forEach(row => {
      deviceStats[row.status] = parseInt(row.count);
    });

    // Get recent heartbeat statistics
    const heartbeatStatsResult = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM heartbeats 
      WHERE license_id = $1 
        AND created_at > now() - interval '24 hours'
      GROUP BY status
    `, [license.id]);

    const heartbeatStats = {};
    heartbeatStatsResult.rows.forEach(row => {
      heartbeatStats[row.status] = parseInt(row.count);
    });

    // Determine pricing tier
    let pricingTier;
    if (license.max_devices >= 1 && license.max_devices <= 50) {
      pricingTier = 'starter';
    } else if (license.max_devices >= 51 && license.max_devices <= 500) {
      pricingTier = 'business';
    } else if (license.max_devices >= 501) {
      pricingTier = 'enterprise';
    }

    res.json({
      licenseKey,
      maxDevices: license.max_devices,
      pricingTier: pricingTier,
      status: license.status,
      customerEmail: license.customer_email,
      customerName: license.customer_name,
      deviceStats: {
        active: deviceStats.active || 0,
        removed: deviceStats.removed || 0,
        total: Object.values(deviceStats).reduce((sum, count) => sum + count, 0)
      },
      heartbeatStats24h: {
        ok: heartbeatStats.ok || 0,
        warn: heartbeatStats.warn || 0,
        error: heartbeatStats.error || 0,
        total: Object.values(heartbeatStats).reduce((sum, count) => sum + count, 0)
      }
    });

  } catch (error) {
    console.error('License stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 SyncSure Heartbeat API v3.3.0 running on port ${port}`);
  console.log(`🔒 Rate limiting: Heartbeats (2/min), Device management (10/min), Emails (5/min)`);
  console.log(`💰 New pricing model: Starter (1-50 devices @ £1.99), Business (51-500 @ £1.49), Enterprise (500+ @ £0.99)`);
  console.log(`📧 Email notifications enabled via Resend`);
  console.log(`🗄️ Database: PostgreSQL with comprehensive schema`);
  console.log(`⚡ Features: Device management, offline monitoring, audit logging`);
});

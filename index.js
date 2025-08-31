import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import pg from 'pg';
import cron from 'node-cron';
import { Resend } from 'resend';

const { Pool } = pg;

// Initialize Resend (safely handle missing API key)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app = express();
const port = process.env.PORT || 10000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || true,
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

console.log('🚀 SyncSure Backend with Device Management running on port', port);
console.log('📧 Email notifications:', resend ? 'Enabled' : 'Disabled');
console.log('⏰ Device management scheduled: Daily at 2 AM and every 6 hours');

// ---------- Enhanced Database Schema Setup with Safe ID Addition ----------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up enhanced database schema...');
    
    // Create the users table if it doesn't exist
    await client.query(`
      create table if not exists users (
        id          bigserial primary key,
        email       text not null unique,
        password    text not null,
        created_at  timestamptz not null default now()
      );
    `);

    // Check for the pw_hash column and add it if it's missing
    const res = await client.query(`
      select 1 from information_schema.columns
      where table_name='users' and column_name='pw_hash'
    `);
    if (res.rowCount === 0) {
      console.log('Adding missing "pw_hash" column to "users" table...');
      await client.query(`
        alter table users add column pw_hash text not null default 'migration_placeholder';
      `);
      console.log('Column "pw_hash" added.');
    }

    // Create licenses table with UUID support
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 5,
        customer_email VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NULL,
        CONSTRAINT licenses_status_check CHECK (status IN ('active', 'suspended', 'cancelled', 'expired')),
        CONSTRAINT licenses_max_devices_check CHECK (max_devices > 0)
      );
    `);

    // Create license_bindings table with safe ID addition
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        device_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        grace_period_start TIMESTAMPTZ NULL,
        offline_notification_sent BOOLEAN DEFAULT false,
        cleanup_notification_sent BOOLEAN DEFAULT false,
        CONSTRAINT unique_license_device UNIQUE (license_id, device_hash),
        CONSTRAINT license_bindings_status_check CHECK (status IN ('active', 'grace_period', 'removed'))
      );
    `);

    // Safely add ID column to license_bindings if it doesn't exist
    const idColumnExists = await client.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='license_bindings' AND column_name='id'
    `);
    
    if (idColumnExists.rowCount === 0) {
      console.log('🔧 Adding ID column to license_bindings table for better performance...');
      
      // Add ID column
      await client.query('ALTER TABLE license_bindings ADD COLUMN id BIGSERIAL;');
      
      // Check if there's already a primary key
      const pkExists = await client.query(`
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name='license_bindings' AND constraint_type='PRIMARY KEY'
      `);
      
      if (pkExists.rowCount === 0) {
        // Add primary key constraint
        await client.query('ALTER TABLE license_bindings ADD CONSTRAINT license_bindings_pkey PRIMARY KEY (id);');
        console.log('✅ ID column and primary key added successfully');
      } else {
        console.log('✅ ID column added (primary key already exists)');
      }
    }

    // Add missing columns to license_bindings if they don't exist
    const columnsToAdd = [
      { name: 'last_seen', type: 'TIMESTAMPTZ DEFAULT NOW()' },
      { name: 'device_name', type: 'VARCHAR(255)' },
      { name: 'status', type: 'VARCHAR(50) DEFAULT \'active\'' },
      { name: 'grace_period_start', type: 'TIMESTAMPTZ NULL' },
      { name: 'offline_notification_sent', type: 'BOOLEAN DEFAULT false' },
      { name: 'cleanup_notification_sent', type: 'BOOLEAN DEFAULT false' }
    ];

    for (const column of columnsToAdd) {
      const columnExists = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='license_bindings' AND column_name='${column.name}'
      `);
      
      if (columnExists.rowCount === 0) {
        await client.query(`ALTER TABLE license_bindings ADD COLUMN ${column.name} ${column.type};`);
        console.log(`✅ Added column: ${column.name}`);
      }
    }

    // Create heartbeats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        message TEXT,
        raw_data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT heartbeats_status_check CHECK (status IN ('ok', 'warn', 'error', 'asleep'))
      );
    `);

    // Create device management log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_management_log (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Update existing records with default values
    await client.query('UPDATE license_bindings SET last_seen = NOW() WHERE last_seen IS NULL;');
    await client.query('UPDATE license_bindings SET device_name = device_hash WHERE device_name IS NULL;');
    await client.query('UPDATE license_bindings SET status = \'active\' WHERE status IS NULL;');

    // Create performance indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_license_id ON license_bindings(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_device_hash ON license_bindings(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_license_id ON heartbeats(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_device_hash ON heartbeats(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_created_at ON heartbeats(created_at);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_management_log_license_id ON device_management_log(license_id);');

    // Create indexes for new columns only if they exist
    const lastSeenExists = await client.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='license_bindings' AND column_name='last_seen'
    `);
    if (lastSeenExists.rowCount > 0) {
      await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_last_seen ON license_bindings(last_seen);');
      await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_status ON license_bindings(status);');
    }

    // Insert test licenses
    await client.query(`
      INSERT INTO licenses (key, status, max_devices, customer_email) VALUES 
        ('SYNC-TEST-123', 'active', 10, 'test@example.com'),
        ('SYNC-DEMO-456', 'active', 5, 'demo@example.com'),
        ('SYNC-PROD-789', 'active', 25, 'customer@example.com')
      ON CONFLICT (key) DO UPDATE SET
        status = EXCLUDED.status,
        max_devices = EXCLUDED.max_devices,
        customer_email = COALESCE(licenses.customer_email, EXCLUDED.customer_email);
    `);

    // Create test user if it doesn't exist
    const testUserExists = await client.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
    if (testUserExists.rowCount === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(
        'INSERT INTO users (email, password, pw_hash) VALUES ($1, $2, $3)',
        ['test@example.com', 'password123', hashedPassword]
      );
      console.log('✅ Test user created: test@example.com / password123');
    }

    console.log('✅ Enhanced database schema setup complete!');
    
  } catch (err) {
    console.error('❌ Error during schema setup:', err);
  } finally {
    client.release();
  }
}

// Initialize database schema on startup
ensureSchema();

// ---------- Event Normalization ----------
const eventCatalog = {
  // Sync Status Events
  'sync_status_check': { status: 'ok', eventType: 'sync_status_check' },
  'sync_healthy': { status: 'ok', eventType: 'sync_status_check' },
  'sync_running': { status: 'ok', eventType: 'sync_status_check' },
  'sync_up_to_date': { status: 'ok', eventType: 'sync_status_check' },
  
  // Pause Events
  'sync_paused': { status: 'warn', eventType: 'sync_paused' },
  'sync_stopped': { status: 'warn', eventType: 'sync_paused' },
  'pause_detected': { status: 'warn', eventType: 'sync_paused' },
  'onedrive_paused': { status: 'warn', eventType: 'sync_paused' },
  
  // Error Events
  'sync_error': { status: 'error', eventType: 'sync_error' },
  'sync_failed': { status: 'error', eventType: 'sync_error' },
  'auth_error': { status: 'error', eventType: 'sync_error' },
  'storage_error': { status: 'error', eventType: 'sync_error' },
  'connectivity_error': { status: 'error', eventType: 'sync_error' },
  'process_error': { status: 'error', eventType: 'sync_error' },
  
  // Process Events
  'process_running': { status: 'ok', eventType: 'sync_status_check' },
  'process_healthy': { status: 'ok', eventType: 'sync_status_check' },
  'process_warning': { status: 'warn', eventType: 'sync_status_check' },
  'process_critical': { status: 'error', eventType: 'sync_error' },
  
  // Authentication Events
  'auth_ok': { status: 'ok', eventType: 'sync_status_check' },
  'auth_warning': { status: 'warn', eventType: 'sync_status_check' },
  'auth_critical': { status: 'error', eventType: 'sync_error' },
  
  // Storage Events
  'storage_ok': { status: 'ok', eventType: 'sync_status_check' },
  'storage_warning': { status: 'warn', eventType: 'sync_status_check' },
  'storage_critical': { status: 'error', eventType: 'sync_error' },
  
  // Performance Events
  'performance_ok': { status: 'ok', eventType: 'sync_status_check' },
  'performance_warning': { status: 'warn', eventType: 'sync_status_check' },
  'performance_critical': { status: 'error', eventType: 'sync_error' },
  
  // Connectivity Events
  'connectivity_ok': { status: 'ok', eventType: 'sync_status_check' },
  'connectivity_warning': { status: 'warn', eventType: 'sync_status_check' },
  'connectivity_critical': { status: 'error', eventType: 'sync_error' },
  
  // Power/System Events
  'device_asleep': { status: 'ok', eventType: 'sync_status_check' },
  'device_offline': { status: 'ok', eventType: 'sync_status_check' },
  'device_shutdown': { status: 'ok', eventType: 'sync_status_check' },
  'device_hibernating': { status: 'ok', eventType: 'sync_status_check' }
};

function normalizeEvent(eventType, status) {
  const normalized = eventCatalog[eventType];
  if (normalized) {
    return normalized;
  }
  
  // Fallback normalization based on status
  if (status === 'error') {
    return { status: 'error', eventType: 'sync_error' };
  } else if (status === 'warn') {
    return { status: 'warn', eventType: 'sync_status_check' };
  } else {
    return { status: 'ok', eventType: 'sync_status_check' };
  }
}

// ---------- License Validation Middleware ----------
async function validateLicense(licenseKey) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, status, max_devices, customer_email FROM licenses WHERE key = $1',
      [licenseKey]
    );
    
    if (result.rowCount === 0) {
      return { valid: false, error: 'Invalid license key' };
    }
    
    const license = result.rows[0];
    
    if (license.status !== 'active') {
      return { valid: false, error: 'License is not active' };
    }
    
    return { valid: true, license };
  } catch (error) {
    console.error('License validation error:', error);
    return { valid: false, error: 'License validation failed' };
  } finally {
    client.release();
  }
}

// ---------- Device Management Functions ----------
async function updateDeviceLastSeen(licenseId, deviceHash) {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE license_bindings 
      SET last_seen = NOW(), 
          status = 'active',
          grace_period_start = NULL
      WHERE license_id = $1 AND device_hash = $2
    `, [licenseId, deviceHash]);
  } catch (error) {
    console.error('Error updating device last seen:', error);
  } finally {
    client.release();
  }
}

async function bindDeviceToLicense(licenseId, deviceHash) {
  const client = await pool.connect();
  try {
    // Check current device count for this license
    const countResult = await client.query(
      'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status != \'removed\'',
      [licenseId]
    );
    
    const currentDevices = parseInt(countResult.rows[0].count);
    
    // Get license max devices
    const licenseResult = await client.query(
      'SELECT max_devices FROM licenses WHERE id = $1',
      [licenseId]
    );
    
    const maxDevices = licenseResult.rows[0]?.max_devices || 1;
    
    if (currentDevices >= maxDevices) {
      return { success: false, error: 'Device seat limit reached' };
    }
    
    // Bind device to license
    await client.query(`
      INSERT INTO license_bindings (license_id, device_hash, device_name, status, last_seen)
      VALUES ($1, $2, $3, 'active', NOW())
      ON CONFLICT (license_id, device_hash) 
      DO UPDATE SET 
        last_seen = NOW(),
        status = 'active',
        grace_period_start = NULL,
        device_name = COALESCE(license_bindings.device_name, EXCLUDED.device_name)
    `, [licenseId, deviceHash, deviceHash]);
    
    // Log the binding
    await client.query(`
      INSERT INTO device_management_log (license_id, device_hash, action, details)
      VALUES ($1, $2, 'device_bound', 'Device automatically bound to license')
    `, [licenseId, deviceHash]);
    
    return { success: true };
  } catch (error) {
    console.error('Error binding device to license:', error);
    return { success: false, error: 'Failed to bind device' };
  } finally {
    client.release();
  }
}

// ---------- Enhanced Heartbeat Handler ----------
async function handleHeartbeatInsert(licenseId, deviceHash, status, eventType, message, rawData) {
  const client = await pool.connect();
  try {
    // Check if device is bound to license
    const bound = await client.query(
      'SELECT license_id, device_hash, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2 LIMIT 1',
      [licenseId, deviceHash]
    );
    
    if (bound.rowCount === 0) {
      // Auto-bind device to license
      const bindResult = await bindDeviceToLicense(licenseId, deviceHash);
      if (!bindResult.success) {
        throw new Error(bindResult.error);
      }
    } else {
      // Update last seen for existing device
      await updateDeviceLastSeen(licenseId, deviceHash);
    }
    
    // Insert heartbeat record
    await client.query(`
      INSERT INTO heartbeats (license_id, device_hash, status, event_type, message, raw_data, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [licenseId, deviceHash, status, eventType, message, rawData]);
    
  } catch (error) {
    console.error('Heartbeat insert error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// ---------- Device Management Automation ----------
async function runDeviceManagement() {
  const client = await pool.connect();
  try {
    console.log('🔧 Running device management cycle...');
    
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    // Find devices entering grace period (offline 7+ days, not already in grace period)
    const gracePeriodDevices = await client.query(`
      SELECT lb.license_id, lb.device_hash, lb.device_name, l.customer_email, l.key as license_key
      FROM license_bindings lb
      JOIN licenses l ON lb.license_id = l.id
      WHERE lb.last_seen < $1 
        AND lb.status = 'active'
        AND lb.grace_period_start IS NULL
    `, [sevenDaysAgo]);
    
    // Move devices to grace period
    for (const device of gracePeriodDevices.rows) {
      await client.query(`
        UPDATE license_bindings 
        SET status = 'grace_period', grace_period_start = NOW()
        WHERE license_id = $1 AND device_hash = $2
      `, [device.license_id, device.device_hash]);
      
      // Log the action
      await client.query(`
        INSERT INTO device_management_log (license_id, device_hash, action, details)
        VALUES ($1, $2, 'grace_period_started', 'Device offline for 7+ days, grace period started')
      `, [device.license_id, device.device_hash]);
      
      // Send email notification
      if (resend && device.customer_email && !device.offline_notification_sent) {
        try {
          await resend.emails.send({
            from: process.env.FROM_EMAIL || 'SyncSure <noreply@syncsure.com>',
            to: device.customer_email,
            subject: `SyncSure Alert: Device "${device.device_name}" Offline`,
            html: `
              <h2>Device Offline Alert</h2>
              <p>Your SyncSure device <strong>${device.device_name}</strong> has been offline for 7+ days.</p>
              <p><strong>License:</strong> ${device.license_key}</p>
              <p><strong>Grace Period:</strong> 23 days remaining before automatic removal</p>
              <p>If this device is no longer needed, no action is required. It will be automatically removed in 23 days to free up your license seat.</p>
              <p>If you need this device, please restart the SyncSure agent on that computer.</p>
            `
          });
          
          // Mark notification as sent
          await client.query(`
            UPDATE license_bindings 
            SET offline_notification_sent = true
            WHERE license_id = $1 AND device_hash = $2
          `, [device.license_id, device.device_hash]);
          
          console.log(`📧 Grace period email sent to ${device.customer_email} for device ${device.device_name}`);
        } catch (emailError) {
          console.error('Email sending error:', emailError);
        }
      }
    }
    
    // Find devices to remove (offline 30+ days)
    const devicesToRemove = await client.query(`
      SELECT lb.license_id, lb.device_hash, lb.device_name, l.customer_email, l.key as license_key
      FROM license_bindings lb
      JOIN licenses l ON lb.license_id = l.id
      WHERE lb.last_seen < $1 
        AND lb.status IN ('active', 'grace_period')
    `, [thirtyDaysAgo]);
    
    // Remove devices and free up seats
    for (const device of devicesToRemove.rows) {
      await client.query(`
        UPDATE license_bindings 
        SET status = 'removed'
        WHERE license_id = $1 AND device_hash = $2
      `, [device.license_id, device.device_hash]);
      
      // Log the removal
      await client.query(`
        INSERT INTO device_management_log (license_id, device_hash, action, details)
        VALUES ($1, $2, 'device_removed', 'Device offline for 30+ days, automatically removed to free license seat')
      `, [device.license_id, device.device_hash]);
      
      // Send cleanup notification email
      if (resend && device.customer_email && !device.cleanup_notification_sent) {
        try {
          await resend.emails.send({
            from: process.env.FROM_EMAIL || 'SyncSure <noreply@syncsure.com>',
            to: device.customer_email,
            subject: `SyncSure: Device "${device.device_name}" Removed`,
            html: `
              <h2>Device Automatically Removed</h2>
              <p>Your SyncSure device <strong>${device.device_name}</strong> has been automatically removed after being offline for 30+ days.</p>
              <p><strong>License:</strong> ${device.license_key}</p>
              <p><strong>Benefit:</strong> This has freed up a license seat for new devices</p>
              <p>If you need to monitor this device again, simply install and run SyncSure on that computer with your license key.</p>
            `
          });
          
          // Mark cleanup notification as sent
          await client.query(`
            UPDATE license_bindings 
            SET cleanup_notification_sent = true
            WHERE license_id = $1 AND device_hash = $2
          `, [device.license_id, device.device_hash]);
          
          console.log(`📧 Cleanup email sent to ${device.customer_email} for device ${device.device_name}`);
        } catch (emailError) {
          console.error('Cleanup email error:', emailError);
        }
      }
    }
    
    console.log(`✅ Device management completed: ${gracePeriodDevices.rowCount} grace period, ${devicesToRemove.rowCount} removed`);
    
  } catch (error) {
    console.error('Device management error:', error);
  } finally {
    client.release();
  }
}

// Schedule device management
cron.schedule('0 2 * * *', runDeviceManagement); // Daily at 2 AM
cron.schedule('0 */6 * * *', runDeviceManagement); // Every 6 hours

// ---------- API Routes ----------

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Enhanced heartbeat endpoint with license validation
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { licenseKey, deviceHash, status, eventType, message, timestamp } = req.body;
    
    // Validate required fields
    if (!licenseKey || !deviceHash || !status || !eventType) {
      return res.status(400).json({ 
        error: 'Missing required fields: licenseKey, deviceHash, status, eventType' 
      });
    }
    
    // Validate license
    const licenseValidation = await validateLicense(licenseKey);
    if (!licenseValidation.valid) {
      return res.status(401).json({ error: licenseValidation.error });
    }
    
    const license = licenseValidation.license;
    
    // Normalize event
    const normalized = normalizeEvent(eventType, status);
    
    // Store heartbeat with enhanced device management
    await handleHeartbeatInsert(
      license.id, 
      deviceHash, 
      normalized.status, 
      normalized.eventType, 
      message || '', 
      req.body
    );
    
    res.json({ 
      ok: true, 
      normalized: normalized,
      license_info: `${licenseKey} (${license.customer_email})`
    });
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Offline heartbeat endpoint
app.post('/api/heartbeat/offline', async (req, res) => {
  try {
    const { licenseKey, deviceHash, reason } = req.body;
    
    if (!licenseKey || !deviceHash) {
      return res.status(400).json({ error: 'Missing licenseKey or deviceHash' });
    }
    
    // Validate license
    const licenseValidation = await validateLicense(licenseKey);
    if (!licenseValidation.valid) {
      return res.status(401).json({ error: licenseValidation.error });
    }
    
    const license = licenseValidation.license;
    
    // Store offline heartbeat
    await handleHeartbeatInsert(
      license.id,
      deviceHash,
      'ok',
      'sync_status_check',
      reason || 'Device going offline',
      { ...req.body, offline: true }
    );
    
    res.json({ ok: true, message: 'Offline heartbeat recorded' });
    
  } catch (error) {
    console.error('Offline heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enhanced devices API with device management info
app.get('/api/devices/:licenseKey', async (req, res) => {
  try {
    const { licenseKey } = req.params;
    
    // Validate license
    const licenseValidation = await validateLicense(licenseKey);
    if (!licenseValidation.valid) {
      return res.status(401).json({ error: licenseValidation.error });
    }
    
    const license = licenseValidation.license;
    
    // Get devices with enhanced information
    const result = await client.query(`
      SELECT 
        lb.license_id,
        lb.device_hash,
        lb.bound_at,
        lb.device_name,
        lb.status,
        lb.grace_period_start,
        lb.offline_notification_sent,
        lb.cleanup_notification_sent,
        lb.last_seen,
        EXTRACT(EPOCH FROM (NOW() - lb.last_seen)) / 3600 as hours_offline,
        CASE 
          WHEN lb.last_seen > NOW() - INTERVAL '5 minutes' THEN 'Online'
          WHEN lb.last_seen > NOW() - INTERVAL '1 hour' THEN 'Recently Online'
          WHEN lb.status = 'grace_period' THEN 'Grace Period'
          WHEN lb.status = 'removed' THEN 'Removed'
          ELSE 'Offline'
        END as connection_status
      FROM license_bindings lb
      WHERE lb.license_id = $1 AND lb.status != 'removed'
      ORDER BY lb.last_seen DESC
    `, [license.id]);
    
    res.json({
      licenseKey: licenseKey,
      maxDevices: license.max_devices,
      devices: result.rows
    });
    
  } catch (error) {
    console.error('Devices API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enhanced heartbeats API with device management
app.get('/api/heartbeats', async (req, res) => {
  try {
    const { licenseKey } = req.query;
    
    if (!licenseKey) {
      return res.status(400).json({ error: 'licenseKey parameter required' });
    }
    
    // Validate license
    const licenseValidation = await validateLicense(licenseKey);
    if (!licenseValidation.valid) {
      return res.status(401).json({ error: licenseValidation.error });
    }
    
    const license = licenseValidation.license;
    
    // Get latest heartbeat for each device with enhanced info
    const result = await client.query(`
      SELECT DISTINCT ON (lb.device_hash)
        lb.device_hash,
        lb.device_name,
        lb.last_seen,
        lb.status as device_status,
        lb.grace_period_start,
        h.status as last_status,
        h.event_type as last_event_type,
        h.message as last_message,
        CASE 
          WHEN h.status = 'error' THEN 'error'
          WHEN h.status = 'warn' THEN 'warn'
          ELSE 'ok'
        END as display_status
      FROM license_bindings lb
      LEFT JOIN heartbeats h ON lb.license_id = h.license_id AND lb.device_hash = h.device_hash
      WHERE lb.license_id = $1 AND lb.status != 'removed'
      ORDER BY lb.device_hash, h.created_at DESC
    `, [license.id]);
    
    res.json({ devices: result.rows });
    
  } catch (error) {
    console.error('Heartbeats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual device management trigger
app.post('/api/admin/run-device-management', async (req, res) => {
  try {
    await runDeviceManagement();
    res.json({ ok: true, message: 'Device management completed' });
  } catch (error) {
    console.error('Manual device management error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database migration endpoint
app.post('/api/admin/migrate-database', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('🔧 Running database migration...');
    
    // Add missing columns to license_bindings table
    const columns = [
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS device_name VARCHAR(255)',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT \'active\'',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS grace_period_start TIMESTAMPTZ NULL',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS offline_notification_sent BOOLEAN DEFAULT false',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS cleanup_notification_sent BOOLEAN DEFAULT false'
    ];
    
    for (const sql of columns) {
      await client.query(sql);
    }
    
    // Safely add ID column if it doesn't exist
    const idColumnExists = await client.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='license_bindings' AND column_name='id'
    `);
    
    if (idColumnExists.rowCount === 0) {
      console.log('🔧 Adding ID column to license_bindings table...');
      await client.query('ALTER TABLE license_bindings ADD COLUMN id BIGSERIAL;');
      
      // Check if primary key exists
      const pkExists = await client.query(`
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name='license_bindings' AND constraint_type='PRIMARY KEY'
      `);
      
      if (pkExists.rowCount === 0) {
        await client.query('ALTER TABLE license_bindings ADD CONSTRAINT license_bindings_pkey PRIMARY KEY (id);');
      }
      
      console.log('✅ ID column added successfully');
    }
    
    // Update existing records
    await client.query('UPDATE license_bindings SET last_seen = NOW() WHERE last_seen IS NULL');
    await client.query('UPDATE license_bindings SET device_name = device_hash WHERE device_name IS NULL');
    await client.query('UPDATE license_bindings SET status = \'active\' WHERE status IS NULL');
    
    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_last_seen ON license_bindings(last_seen)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_status ON license_bindings(status)');
    
    console.log('✅ Database migration completed');
    res.json({ ok: true, message: 'Database migration completed successfully' });
    
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Remove device endpoint
app.delete('/api/devices/:licenseKey/:deviceHash', async (req, res) => {
  try {
    const { licenseKey, deviceHash } = req.params;
    
    // Validate license
    const licenseValidation = await validateLicense(licenseKey);
    if (!licenseValidation.valid) {
      return res.status(401).json({ error: licenseValidation.error });
    }
    
    const license = licenseValidation.license;
    
    const client = await pool.connect();
    try {
      // Remove device (mark as removed)
      await client.query(`
        UPDATE license_bindings 
        SET status = 'removed'
        WHERE license_id = $1 AND device_hash = $2
      `, [license.id, deviceHash]);
      
      // Log the manual removal
      await client.query(`
        INSERT INTO device_management_log (license_id, device_hash, action, details)
        VALUES ($1, $2, 'manual_removal', 'Device manually removed by admin')
      `, [license.id, deviceHash]);
      
      res.json({ ok: true, message: 'Device removed successfully' });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Device removal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard statistics
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const stats = await client.query(`
        SELECT 
          COUNT(*) as total_devices,
          COUNT(*) FILTER (WHERE status = 'active') as active_devices,
          COUNT(*) FILTER (WHERE status = 'grace_period') as grace_period_devices,
          COUNT(*) FILTER (WHERE status = 'removed') as removed_devices,
          COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '5 minutes') as online_devices,
          COUNT(*) FILTER (WHERE last_seen < NOW() - INTERVAL '1 hour') as offline_devices
        FROM license_bindings
      `);
      
      res.json(stats.rows[0]);
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const client = await pool.connect();
    try {
      // Check if user already exists
      const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingUser.rowCount > 0) {
        return res.status(409).json({ error: 'User already exists' });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // Create user
      const result = await client.query(
        'INSERT INTO users (email, password, pw_hash) VALUES ($1, $2, $3) RETURNING id, email, created_at',
        [email, password, hashedPassword]
      );
      
      const user = result.rows[0];
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      
      res.json({ 
        ok: true, 
        user: { id: user.id, email: user.email, created_at: user.created_at }
      });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const client = await pool.connect();
    try {
      // Find user
      const result = await client.query('SELECT id, email, pw_hash, created_at FROM users WHERE email = $1', [email]);
      if (result.rowCount === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const user = result.rows[0];
      
      // Verify password
      const validPassword = await bcrypt.compare(password, user.pw_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Set session
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      
      res.json({ 
        ok: true, 
        user: { id: user.id, email: user.email, created_at: user.created_at }
      });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ ok: true, message: 'Logged out successfully' });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  res.json({ 
    ok: true, 
    user: { 
      id: req.session.userId, 
      email: req.session.userEmail 
    }
  });
});

// Licenses route
app.get('/api/licenses', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          l.key,
          l.status,
          l.max_devices,
          l.customer_email,
          l.created_at,
          COUNT(lb.device_hash) FILTER (WHERE lb.status != 'removed') as active_devices
        FROM licenses l
        LEFT JOIN license_bindings lb ON l.id = lb.license_id
        GROUP BY l.id, l.key, l.status, l.max_devices, l.customer_email, l.created_at
        ORDER BY l.created_at DESC
      `);
      
      res.json({ licenses: result.rows });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Licenses API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats route
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const stats = await client.query(`
        SELECT 
          COUNT(DISTINCT l.id) as total_licenses,
          COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'active') as active_licenses,
          COUNT(lb.device_hash) as total_devices,
          COUNT(lb.device_hash) FILTER (WHERE lb.status = 'active') as active_devices,
          COUNT(lb.device_hash) FILTER (WHERE lb.status = 'grace_period') as grace_period_devices,
          COUNT(lb.device_hash) FILTER (WHERE lb.last_seen > NOW() - INTERVAL '5 minutes') as online_devices
        FROM licenses l
        LEFT JOIN license_bindings lb ON l.id = lb.license_id AND lb.status != 'removed'
      `);
      
      res.json(stats.rows[0]);
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Server running on http://0.0.0.0:${port}`);
});

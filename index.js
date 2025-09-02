import express from 'express';
import cors from 'cors';
import pg from 'pg';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 10000;

// Database connection with Render PostgreSQL optimizations
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// CORS - Optimized for Replit frontend
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

// Rate limiting for API protection
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

// Database schema setup - Render PostgreSQL optimized
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up SyncSure database schema on Render PostgreSQL...');
    
    // Licenses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        max_devices INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'active',
        customer_email VARCHAR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);

    // License bindings table with all required columns
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

    // Heartbeats table
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

    // Device management log table
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_management_log_license 
      ON device_management_log(license_id, created_at DESC)
    `);

    // Create test license if it doesn't exist
    const testLicenseExists = await client.query('SELECT id FROM licenses WHERE key = $1', ['SYNC-TEST-123']);
    if (testLicenseExists.rowCount === 0) {
      await client.query(
        'INSERT INTO licenses (key, max_devices, status, customer_email) VALUES ($1, $2, $3, $4)',
        ['SYNC-TEST-123', 10, 'active', 'test@syncsure.com']
      );
      console.log('✅ Test license created: SYNC-TEST-123');
    }

    console.log('✅ SyncSure database schema setup complete on Render PostgreSQL!');
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
    version: '3.2.0',
    database: 'render-postgresql',
    features: ['heartbeat-processing', 'device-management', 'manual-removal'],
    timestamp: new Date().toISOString() 
  });
});

// Main heartbeat endpoint
app.post('/api/heartbeat', heartbeatLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { licenseKey, deviceHash, status, eventType, message, timestamp } = req.body;

    // Validate required fields
    if (!licenseKey || !deviceHash || !status) {
      return res.status(400).json({ 
        error: 'Missing required fields: licenseKey, deviceHash, status' 
      });
    }

    // Get license with minimal query
    const licenseResult = await pool.query(
      'SELECT id, status, max_devices FROM licenses WHERE key = $1',
      [licenseKey]
    );

    if (licenseResult.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid license key' });
    }

    const license = licenseResult.rows[0];
    if (license.status !== 'active') {
      return res.status(403).json({ error: 'License is not active' });
    }

    // Check/create device binding (exclude removed devices)
    const bindingResult = await pool.query(
      'SELECT id, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [license.id, deviceHash]
    );

    if (bindingResult.rowCount === 0) {
      // Check device limit before binding new device
      const deviceCountResult = await pool.query(
        'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status = $2',
        [license.id, 'active']
      );

      const deviceCount = parseInt(deviceCountResult.rows[0].count);
      if (deviceCount >= license.max_devices) {
        return res.status(403).json({ 
          error: 'Device limit reached for this license',
          current_devices: deviceCount,
          max_devices: license.max_devices
        });
      }

      // Bind new device
      await pool.query(
        'INSERT INTO license_bindings (license_id, device_hash, device_name, status, last_seen, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [license.id, deviceHash, deviceHash, 'active', new Date(), new Date()]
      );
      
      console.log(`✅ New device bound: ${deviceHash} to license ${licenseKey}`);
    } else {
      const binding = bindingResult.rows[0];
      
      // Check if device was removed
      if (binding.status === 'removed') {
        return res.status(403).json({ 
          error: 'Device has been removed from monitoring',
          message: 'This device is no longer authorized. Please contact support if you need to re-enable monitoring.'
        });
      }

      // Update existing binding
      await pool.query(
        'UPDATE license_bindings SET last_seen = $1, updated_at = $2 WHERE license_id = $3 AND device_hash = $4',
        [new Date(), new Date(), license.id, deviceHash]
      );
    }

    // Normalize the event
    const normalized = normalizeEvent(status, eventType);

    // Insert heartbeat (async, don't wait)
    pool.query(
      'INSERT INTO heartbeats (license_id, device_hash, status, event_type, message, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
      [license.id, deviceHash, normalized.status, normalized.eventType, message || 'Heartbeat received', timestamp || new Date()]
    ).catch(error => {
      console.error('❌ Heartbeat insert error:', error);
    });

    const processingTime = Date.now() - startTime;
    
    // Success response
    res.json({ 
      ok: true, 
      normalized: normalized,
      processing_time_ms: processingTime,
      database: 'render-postgresql'
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Heartbeat processing error:', error);
    
    res.status(500).json({ 
      error: 'Internal server error',
      processing_time_ms: processingTime
    });
  }
});

// Manual device removal endpoint
app.delete('/api/device/:licenseKey/:deviceHash', deviceManagementLimiter, async (req, res) => {
  const { licenseKey, deviceHash } = req.params;
  
  try {
    // Validate license exists and is active
    const license = await pool.query(
      'SELECT id FROM licenses WHERE key = $1 AND status = $2',
      [licenseKey, 'active']
    );
    
    if (license.rows.length === 0) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    const licenseId = license.rows[0].id;
    
    // Check if device binding exists
    const binding = await pool.query(
      'SELECT id, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [licenseId, deviceHash]
    );
    
    if (binding.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Check if device is already removed
    if (binding.rows[0].status === 'removed') {
      return res.status(400).json({ error: 'Device is already removed' });
    }
    
    // Remove device binding (soft delete)
    await pool.query(
      'UPDATE license_bindings SET status = $1, updated_at = $2 WHERE license_id = $3 AND device_hash = $4',
      ['removed', new Date(), licenseId, deviceHash]
    );
    
    // Log the removal action
    await pool.query(
      'INSERT INTO device_management_log (license_id, device_hash, action, details) VALUES ($1, $2, $3, $4)',
      [licenseId, deviceHash, 'manual_removal', 'Device manually removed by customer']
    );
    
    console.log(`✅ Device removed: ${deviceHash} from license ${licenseKey}`);
    
    res.json({ 
      success: true, 
      message: 'Device removed successfully',
      deviceHash: deviceHash,
      licenseKey: licenseKey
    });
    
  } catch (error) {
    console.error('Device removal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Offline heartbeat endpoint
app.post('/api/heartbeat/offline', async (req, res) => {
  try {
    const { licenseKey, deviceHash, message } = req.body;

    if (!licenseKey || !deviceHash) {
      return res.status(400).json({ error: 'Missing required fields: licenseKey, deviceHash' });
    }

    // Validate license
    const licenseResult = await pool.query(
      'SELECT id FROM licenses WHERE key = $1 AND status = $2',
      [licenseKey, 'active']
    );

    if (licenseResult.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid or inactive license' });
    }

    const license = licenseResult.rows[0];

    // Insert offline heartbeat
    pool.query(
      'INSERT INTO heartbeats (license_id, device_hash, status, event_type, message) VALUES ($1, $2, $3, $4, $5)',
      [license.id, deviceHash, 'error', 'sync_error', message || 'Device went offline']
    ).catch(error => {
      console.error('❌ Offline heartbeat insert error:', error);
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Offline heartbeat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get heartbeat data for dashboard (exclude removed devices)
app.get('/api/heartbeats', async (req, res) => {
  try {
    const { licenseKey, limit = 100 } = req.query;

    if (!licenseKey) {
      return res.status(400).json({ error: 'License key required' });
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (h.device_hash)
        h.device_hash,
        COALESCE(lb.device_name, h.device_hash) as device_name,
        h.status as last_status,
        h.event_type as last_event_type,
        h.message as last_message,
        lb.last_seen,
        lb.status as device_status,
        h.created_at as last_heartbeat_time,
        CASE 
          WHEN lb.last_seen > NOW() - INTERVAL '5 minutes' THEN 'online'
          WHEN lb.last_seen > NOW() - INTERVAL '1 hour' THEN 'recent'
          ELSE 'offline'
        END as connection_status
      FROM heartbeats h
      JOIN licenses l ON h.license_id = l.id
      LEFT JOIN license_bindings lb ON h.license_id = lb.license_id AND h.device_hash = lb.device_hash
      WHERE l.key = $1 
        AND (lb.status IS NULL OR lb.status != 'removed')
      ORDER BY h.device_hash, h.created_at DESC
      LIMIT $2
    `, [licenseKey, limit]);

    res.json({ 
      devices: result.rows,
      total_devices: result.rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get heartbeats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get device information for a specific license
app.get('/api/devices/:licenseKey', async (req, res) => {
  try {
    const { licenseKey } = req.params;

    const result = await pool.query(`
      SELECT 
        l.key as license_key,
        l.max_devices,
        l.status as license_status,
        COALESCE(
          json_agg(
            json_build_object(
              'device_hash', lb.device_hash,
              'device_name', COALESCE(lb.device_name, lb.device_hash),
              'status', lb.status,
              'bound_at', lb.bound_at,
              'last_seen', lb.last_seen,
              'connection_status', CASE 
                WHEN lb.last_seen > NOW() - INTERVAL '5 minutes' THEN 'online'
                WHEN lb.last_seen > NOW() - INTERVAL '1 hour' THEN 'recent'
                ELSE 'offline'
              END
            )
          ) FILTER (WHERE lb.device_hash IS NOT NULL AND lb.status != 'removed'),
          '[]'::json
        ) as devices
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id AND lb.status != 'removed'
      WHERE l.key = $1
      GROUP BY l.id, l.key, l.max_devices, l.status
    `, [licenseKey]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    const data = result.rows[0];
    res.json({
      licenseKey: data.license_key,
      maxDevices: data.max_devices,
      licenseStatus: data.license_status,
      devices: data.devices,
      activeDeviceCount: data.devices.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// License validation endpoint
app.get('/api/license/:licenseKey/validate', async (req, res) => {
  try {
    const { licenseKey } = req.params;

    const result = await pool.query(`
      SELECT 
        l.id,
        l.key,
        l.max_devices,
        l.status,
        l.customer_email,
        l.created_at,
        COUNT(lb.device_hash) as active_devices
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id AND lb.status = 'active'
      WHERE l.key = $1
      GROUP BY l.id
    `, [licenseKey]);

    if (result.rowCount === 0) {
      return res.status(404).json({ 
        valid: false, 
        error: 'License not found' 
      });
    }

    const license = result.rows[0];
    
    res.json({
      valid: license.status === 'active',
      license: {
        key: license.key,
        maxDevices: license.max_devices,
        status: license.status,
        customerEmail: license.customer_email,
        createdAt: license.created_at,
        activeDevices: parseInt(license.active_devices),
        availableSlots: license.max_devices - parseInt(license.active_devices)
      }
    });
  } catch (error) {
    console.error('❌ License validation error:', error);
    res.status(500).json({ 
      valid: false, 
      error: 'Validation failed' 
    });
  }
});

// Get device management log
app.get('/api/device-log/:licenseKey', async (req, res) => {
  try {
    const { licenseKey } = req.params;
    const { limit = 50 } = req.query;

    const result = await pool.query(`
      SELECT 
        dml.device_hash,
        dml.action,
        dml.details,
        dml.created_at
      FROM device_management_log dml
      JOIN licenses l ON dml.license_id = l.id
      WHERE l.key = $1
      ORDER BY dml.created_at DESC
      LIMIT $2
    `, [licenseKey, limit]);

    res.json({
      licenseKey: licenseKey,
      logs: result.rows,
      total: result.rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Device log error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// System stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const [licensesResult, devicesResult, heartbeatsResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM licenses WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) as count FROM license_bindings WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) as count FROM heartbeats WHERE created_at > NOW() - INTERVAL \'24 hours\'')
    ]);

    res.json({
      activeLicenses: parseInt(licensesResult.rows[0].count),
      activeDevices: parseInt(devicesResult.rows[0].count),
      heartbeatsLast24h: parseInt(heartbeatsResult.rows[0].count),
      database: 'render-postgresql',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    console.error('❌ Stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    service: 'syncsure-heartbeat-api',
    version: '3.2.0',
    database: 'render-postgresql',
    available_endpoints: [
      'GET /health',
      'POST /api/heartbeat',
      'POST /api/heartbeat/offline',
      'GET /api/heartbeats?licenseKey=X',
      'GET /api/devices/:licenseKey',
      'GET /api/license/:licenseKey/validate',
      'DELETE /api/device/:licenseKey/:deviceHash',
      'GET /api/device-log/:licenseKey',
      'GET /api/stats'
    ]
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    service: 'syncsure-heartbeat-api'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  pool.end(() => {
    console.log('✅ Database pool closed');
    process.exit(0);
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 SyncSure Heartbeat API v3.2.0 running on port ${port}`);
  console.log(`🌐 Server running on http://0.0.0.0:${port}`);
  console.log(`🗄️ Database: Render PostgreSQL`);
  console.log(`📊 Optimized for high-volume heartbeat processing`);
  console.log(`✅ CORS enabled for Replit frontend access`);
  console.log(`🎯 Features: License validation, device binding, heartbeat processing, manual device removal`);
  console.log(`🔒 Rate limiting: Heartbeats (2/min), Device management (10/min)`);
  console.log(`🗃️ Database: Complete schema with device management logging`);
});

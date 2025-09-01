import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 10000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware - FIXED CORS for Replit domains
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'https://sync-sure-agents5.replit.app',
    'https://syncsure.cloud',
    'https://syncsure-frontend.onrender.com'
  ],
  credentials: true
}));

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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

// Database schema setup - FIXED for Replit compatibility
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up Replit-compatible database schema...');
    
    // Users table - EXACT Replit schema
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'SyncSure User',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        pw_hash TEXT NOT NULL DEFAULT 'migration_placeholder'
      )
    `);

    // Licenses table - EXACT Replit schema
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        max_devices INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'active',
        customer_id TEXT,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
        customer_email VARCHAR,
        stripe_customer_id VARCHAR,
        stripe_subscription_id VARCHAR,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE,
        notification_email VARCHAR,
        email_notifications BOOLEAN DEFAULT true
      )
    `);

    // License bindings table - EXACT Replit schema
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash TEXT NOT NULL,
        bound_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        device_name VARCHAR DEFAULT NULL,
        status VARCHAR DEFAULT 'active',
        grace_period_start TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        offline_notification_sent BOOLEAN DEFAULT false,
        cleanup_notification_sent BOOLEAN DEFAULT false,
        last_seen TIMESTAMP WITH TIME ZONE DEFAULT now()
      )
    `);

    // Heartbeats table - FIXED: BIGSERIAL instead of UUID for Replit compatibility
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

    // Alerts table - EXACT Replit schema
    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash TEXT,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        resolved_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Device management log table - EXACT Replit schema
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

    // Create indexes - EXACT Replit indexes
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

    // Create test license if it doesn't exist
    const testLicenseExists = await client.query('SELECT id FROM licenses WHERE key = $1', ['SYNC-TEST-123']);
    if (testLicenseExists.rowCount === 0) {
      await client.query(
        'INSERT INTO licenses (key, max_devices, status, customer_email) VALUES ($1, $2, $3, $4)',
        ['SYNC-TEST-123', 10, 'active', 'test@example.com']
      );
      console.log('✅ Test license created: SYNC-TEST-123');
    }

    // Create test user if it doesn't exist
    const testUserExists = await client.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
    if (testUserExists.rowCount === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(
        'INSERT INTO users (email, password, name, pw_hash) VALUES ($1, $2, $3, $4)',
        ['test@example.com', 'password123', 'Test User', hashedPassword]
      );
      console.log('✅ Test user created: test@example.com / password123');
    }

    console.log('✅ Replit-compatible database schema setup complete!');
  } catch (error) {
    console.error('❌ Error during schema setup:', error);
  } finally {
    client.release();
  }
}

// Initialize database on startup
ensureSchema();

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Authentication routes - BOTH /api/ and /api/auth/ versions for compatibility

// Original authentication routes (keeping for backward compatibility)
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name, pw_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email, password, name || 'SyncSure User', hashedPassword]
    );

    req.session.userId = result.rows[0].id;
    res.json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.pw_hash || user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.session.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// NEW: /api/auth/ versions for Replit frontend compatibility
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name, pw_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email, password, name || 'SyncSure User', hashedPassword]
    );

    req.session.userId = result.rows[0].id;
    res.json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.pw_hash || user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.session.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Heartbeat endpoint - UNCHANGED (your tool will work exactly the same)
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { licenseKey, deviceHash, status, eventType, message, timestamp } = req.body;

    if (!licenseKey || !deviceHash || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate license
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

    // Check if device is already bound
    const bindingResult = await pool.query(
      'SELECT id, status FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [license.id, deviceHash]
    );

    if (bindingResult.rowCount === 0) {
      // Check device limit
      const deviceCountResult = await pool.query(
        'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1 AND status = $2',
        [license.id, 'active']
      );

      const deviceCount = parseInt(deviceCountResult.rows[0].count);
      if (deviceCount >= license.max_devices) {
        return res.status(403).json({ error: 'Device limit reached for this license' });
      }

      // Bind new device
      await pool.query(
        'INSERT INTO license_bindings (license_id, device_hash, device_name, status, last_seen) VALUES ($1, $2, $3, $4, $5)',
        [license.id, deviceHash, deviceHash, 'active', new Date()]
      );
    } else {
      // Update existing binding
      await pool.query(
        'UPDATE license_bindings SET last_seen = $1 WHERE license_id = $2 AND device_hash = $3',
        [new Date(), license.id, deviceHash]
      );
    }

    // Normalize the event
    const normalized = normalizeEvent(status, eventType);

    // Insert heartbeat
    await pool.query(
      'INSERT INTO heartbeats (license_id, device_hash, status, event_type, message, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
      [license.id, deviceHash, normalized.status, normalized.eventType, message, timestamp || new Date()]
    );

    res.json({ 
      ok: true, 
      normalized: normalized
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Offline heartbeat endpoint - UNCHANGED
app.post('/api/heartbeat/offline', async (req, res) => {
  try {
    const { licenseKey, deviceHash, message } = req.body;

    if (!licenseKey || !deviceHash) {
      return res.status(400).json({ error: 'Missing required fields' });
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
    await pool.query(
      'INSERT INTO heartbeats (license_id, device_hash, status, event_type, message) VALUES ($1, $2, $3, $4, $5)',
      [license.id, deviceHash, 'error', 'sync_error', message || 'Device went offline']
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Offline heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get devices for a license
app.get('/api/devices/:licenseKey', async (req, res) => {
  try {
    const { licenseKey } = req.params;

    const result = await pool.query(`
      SELECT 
        l.key as license_key,
        l.max_devices,
        json_agg(
          json_build_object(
            'license_id', lb.license_id,
            'device_hash', lb.device_hash,
            'bound_at', lb.bound_at,
            'device_name', COALESCE(lb.device_name, lb.device_hash),
            'status', lb.status,
            'last_seen', lb.last_seen
          )
        ) as devices
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id
      WHERE l.key = $1
      GROUP BY l.id, l.key, l.max_devices
    `, [licenseKey]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    const data = result.rows[0];
    res.json({
      licenseKey: data.license_key,
      maxDevices: data.max_devices,
      devices: data.devices[0].license_id ? data.devices : []
    });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get heartbeats for dashboard - Replit format
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
        lb.grace_period_start,
        h.status as display_status
      FROM heartbeats h
      JOIN licenses l ON h.license_id = l.id
      LEFT JOIN license_bindings lb ON h.license_id = lb.license_id AND h.device_hash = lb.device_hash
      WHERE l.key = $1
      ORDER BY h.device_hash, h.created_at DESC
      LIMIT $2
    `, [licenseKey, limit]);

    res.json({ devices: result.rows });
  } catch (error) {
    console.error('Get heartbeats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get licenses (for dashboard)
app.get('/api/licenses', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        COUNT(lb.device_hash) as device_count
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id AND lb.status = 'active'
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `);

    res.json({ licenses: result.rows });
  } catch (error) {
    console.error('Get licenses error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const [licensesResult, devicesResult, heartbeatsResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM licenses WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) as count FROM license_bindings WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) as count FROM heartbeats WHERE created_at > NOW() - INTERVAL \'24 hours\'')
    ]);

    res.json({
      activeLicenses: parseInt(licensesResult.rows[0].count),
      totalDevices: parseInt(devicesResult.rows[0].count),
      heartbeatsToday: parseInt(heartbeatsResult.rows[0].count)
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe webhook for license creation (for .exe auto-licensing)
app.post('/api/stripe/webhook', async (req, res) => {
  try {
    const event = req.body;
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const quantity = session.line_items?.data[0]?.quantity || 5;
      
      // Generate unique license key
      const licenseKey = `SYNC-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
      
      // Create license with purchased device count
      await pool.query(
        'INSERT INTO licenses (key, max_devices, customer_email, stripe_customer_id, stripe_subscription_id) VALUES ($1, $2, $3, $4, $5)',
        [licenseKey, quantity, session.customer_email, session.customer, session.subscription]
      );
      
      console.log(`✅ License created via Stripe: ${licenseKey} for ${quantity} devices`);
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 SyncSure backend running on port ${port}`);
  console.log(`🌐 Server running on http://0.0.0.0:${port}`);
  console.log(`📊 Replit-compatible schema with CORS fixes`);
  console.log(`✅ CORS enabled for: sync-sure-agents5.replit.app, syncsure.cloud`);
  console.log(`✅ Authentication endpoints: /api/auth/login, /api/auth/logout, /api/auth/me`);
  console.log(`✅ Heartbeats table: BIGSERIAL ID`);
});

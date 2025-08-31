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

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://syncsure-frontend.onrender.com'],
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

// Database schema setup
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up database schema...');
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        pw_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create licenses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        max_devices INTEGER DEFAULT 1,
        customer_email VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create license_bindings table (simple version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        license_id UUID REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (license_id, device_hash)
      )
    `);

    // Create heartbeats table (simple version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        license_id UUID REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_license_device 
      ON heartbeats(license_id, device_hash)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp 
      ON heartbeats(timestamp DESC)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_license_bindings_device 
      ON license_bindings(device_hash)
    `);

    // Create test license if it doesn't exist
    const testLicenseExists = await client.query('SELECT id FROM licenses WHERE key = $1', ['SYNC-TEST-123']);
    if (testLicenseExists.rowCount === 0) {
      await client.query(
        'INSERT INTO licenses (key, status, max_devices, customer_email) VALUES ($1, $2, $3, $4)',
        ['SYNC-TEST-123', 'active', 10, 'test@example.com']
      );
      console.log('✅ Test license created: SYNC-TEST-123');
    }

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

    console.log('✅ Database schema setup complete!');
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

// Authentication routes
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, pw_hash) VALUES ($1, $2, $3) RETURNING id, email',
      [email, password, hashedPassword]
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
    res.json({ user: { id: user.id, email: user.email } });
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
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.session.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Heartbeat endpoint
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
      'SELECT license_id FROM license_bindings WHERE license_id = $1 AND device_hash = $2',
      [license.id, deviceHash]
    );

    if (bindingResult.rowCount === 0) {
      // Check device limit
      const deviceCountResult = await pool.query(
        'SELECT COUNT(*) as count FROM license_bindings WHERE license_id = $1',
        [license.id]
      );

      const deviceCount = parseInt(deviceCountResult.rows[0].count);
      if (deviceCount >= (license.max_devices || 1)) {
        return res.status(403).json({ error: 'Device limit reached for this license' });
      }

      // Bind new device
      await pool.query(
        'INSERT INTO license_bindings (license_id, device_hash) VALUES ($1, $2)',
        [license.id, deviceHash]
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

// Offline heartbeat endpoint
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
            'bound_at', lb.bound_at
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

// Get heartbeats for dashboard
app.get('/api/heartbeats', async (req, res) => {
  try {
    const { licenseKey, limit = 100 } = req.query;

    if (!licenseKey) {
      return res.status(400).json({ error: 'License key required' });
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (h.device_hash)
        h.device_hash,
        h.device_hash as device_name,
        h.status as last_status,
        h.event_type as last_event_type,
        h.message as last_message,
        h.timestamp as last_seen,
        'active' as device_status,
        null as grace_period_start,
        h.status as display_status
      FROM heartbeats h
      JOIN licenses l ON h.license_id = l.id
      WHERE l.key = $1
      ORDER BY h.device_hash, h.timestamp DESC
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
      LEFT JOIN license_bindings lb ON l.id = lb.license_id
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
      pool.query('SELECT COUNT(*) as count FROM license_bindings'),
      pool.query('SELECT COUNT(*) as count FROM heartbeats WHERE timestamp > NOW() - INTERVAL \'24 hours\'')
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

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 SyncSure backend running on port ${port}`);
  console.log(`🌐 Server running on http://0.0.0.0:${port}`);
});

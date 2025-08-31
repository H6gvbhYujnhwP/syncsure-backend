import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import pg from 'pg';

const { Pool } = pg;

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

console.log('🚀 SyncSure backend running on port', port);

// ---------- Ensure users table exists and is correct ----------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up database schema...');
    
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

    // Create licenses table
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

    // Create license_bindings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT unique_license_device UNIQUE (license_id, device_hash)
      );
    `);

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

    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_license_id ON license_bindings(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_device_hash ON license_bindings(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_license_id ON heartbeats(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_device_hash ON heartbeats(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_created_at ON heartbeats(created_at);');

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

    console.log('✅ Database schema setup complete!');
    
  } catch (err) {
    console.error('❌ Error during schema setup:', err);
  } finally {
    client.release();
  }
}

// Initialize database schema on startup
ensureSchema();

// Event normalization catalog
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Heartbeat endpoint with license validation
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { licenseKey, deviceHash, status, eventType, message, timestamp } = req.body;
    
    // Validate required fields
    if (!licenseKey || !deviceHash || !status || !eventType) {
      return res.status(400).json({ 
        error: 'Missing required fields: licenseKey, deviceHash, status, eventType' 
      });
    }
    
    const client = await pool.connect();
    try {
      // Validate license
      const L = await client.query('select id, status, max_devices from licenses where key=$1', [licenseKey]);
      if (L.rowCount === 0) {
        return res.status(401).json({ error: 'Invalid or inactive license key' });
      }
      if (L.rows[0].status !== 'active') {
        return res.status(403).json({ error: 'License is not active' });
      }
      
      // Check if device is already bound to this license
      const bound = await client.query(
        'select license_id from license_bindings where license_id=$1 and device_hash=$2 limit 1',
        [L.rows[0].id, deviceHash]
      );
      
      if (bound.rowCount === 0) {
        // Check device count for this license
        const cnt = await client.query(
          'select count(*) as c from license_bindings where license_id=$1',
          [L.rows[0].id]
        );
        
        if (cnt.rows[0].c >= (L.rows[0].max_devices || 1)) {
          return res.status(403).json({ error: 'Seat limit reached' });
        }
        
        // Bind device to license
        await client.query(
          'insert into license_bindings (license_id, device_hash) values ($1, $2)',
          [L.rows[0].id, deviceHash]
        );
      }
      
      // Normalize event
      const normalized = normalizeEvent(eventType, status);
      
      // Store heartbeat
      await client.query(`
        insert into heartbeats (license_id, device_hash, status, event_type, message, raw_data, created_at)
        values ($1, $2, $3, $4, $5, $6, now())
      `, [L.rows[0].id, deviceHash, normalized.status, normalized.eventType, message || '', req.body]);
      
      res.json({ 
        ok: true, 
        normalized: normalized
      });
      
    } finally {
      client.release();
    }
    
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
    
    const client = await pool.connect();
    try {
      // Validate license
      const L = await client.query('select id, status from licenses where key=$1', [licenseKey]);
      if (L.rowCount === 0 || L.rows[0].status !== 'active') {
        return res.status(401).json({ error: 'Invalid or inactive license key' });
      }
      
      // Store offline heartbeat
      await client.query(`
        insert into heartbeats (license_id, device_hash, status, event_type, message, raw_data, created_at)
        values ($1, $2, 'ok', 'sync_status_check', $3, $4, now())
      `, [L.rows[0].id, deviceHash, reason || 'Device going offline', { ...req.body, offline: true }]);
      
      res.json({ ok: true, message: 'Offline heartbeat recorded' });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Offline heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get heartbeats for a license
app.get('/api/heartbeats', async (req, res) => {
  try {
    const { licenseKey } = req.query;
    
    if (!licenseKey) {
      return res.status(400).json({ error: 'licenseKey parameter required' });
    }
    
    const client = await pool.connect();
    try {
      // Validate license
      const L = await client.query('select id from licenses where key=$1', [licenseKey]);
      if (L.rowCount === 0) {
        return res.status(401).json({ error: 'Invalid license key' });
      }
      
      // Get latest heartbeat for each device
      const result = await client.query(`
        select distinct on (lb.device_hash)
          lb.device_hash,
          lb.device_hash as device_name,
          h.status as last_status,
          h.event_type as last_event_type,
          h.message as last_message,
          h.created_at as last_seen,
          'active' as device_status,
          null as grace_period_start,
          case 
            when h.status = 'error' then 'error'
            when h.status = 'warn' then 'warn'
            else 'ok'
          end as display_status
        from license_bindings lb
        left join heartbeats h on lb.license_id = h.license_id and lb.device_hash = h.device_hash
        where lb.license_id = $1
        order by lb.device_hash, h.created_at desc
      `, [L.rows[0].id]);
      
      res.json({ devices: result.rows });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Heartbeats error:', error);
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

// Get licenses
app.get('/api/licenses', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        select 
          l.key,
          l.status,
          l.max_devices,
          l.customer_email,
          l.created_at,
          count(lb.device_hash) as active_devices
        from licenses l
        left join license_bindings lb on l.id = lb.license_id
        group by l.id, l.key, l.status, l.max_devices, l.customer_email, l.created_at
        order by l.created_at desc
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

// Dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const stats = await client.query(`
        select 
          count(distinct l.id) as total_licenses,
          count(distinct l.id) filter (where l.status = 'active') as active_licenses,
          count(lb.device_hash) as total_devices,
          count(h.id) as total_heartbeats
        from licenses l
        left join license_bindings lb on l.id = lb.license_id
        left join heartbeats h on l.id = h.license_id
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

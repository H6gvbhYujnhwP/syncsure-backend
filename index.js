// index.js - Complete SyncSure Backend
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import pkg from 'pg';

const { Pool } = pkg;

// ---------- DB connection ----------
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // needed for secure cookies on Render behind proxy
app.use(bodyParser.json({ limit: '256kb' }));

// ---------- Ensure all tables exist and are correct ----------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up database schema...');
    
    // Create the users table if it doesn't exist - using pw_hash for password
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        pw_hash     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create licenses table with basic structure first
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id BIGSERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 5,
        customer_email VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NULL
      );
    `);

    // Create license_bindings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        id BIGSERIAL PRIMARY KEY,
        license_id BIGINT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT unique_license_device UNIQUE (license_id, device_hash)
      );
    `);

    // Create heartbeats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id BIGSERIAL PRIMARY KEY,
        license_id BIGINT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        message TEXT,
        error_detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT heartbeats_status_check CHECK (status IN ('ok', 'warn', 'error', 'asleep'))
      );
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
      CREATE INDEX IF NOT EXISTS idx_license_bindings_license_id ON license_bindings(license_id);
      CREATE INDEX IF NOT EXISTS idx_license_bindings_device_hash ON license_bindings(device_hash);
      CREATE INDEX IF NOT EXISTS idx_heartbeats_license_id ON heartbeats(license_id);
      CREATE INDEX IF NOT EXISTS idx_heartbeats_device_hash ON heartbeats(device_hash);
      CREATE INDEX IF NOT EXISTS idx_heartbeats_created_at ON heartbeats(created_at);
    `);

    // Insert test data
    await client.query(`
      INSERT INTO licenses (key, status, max_devices, customer_email) VALUES
        ('SYNC-TEST-123', 'active', 10, 'test@syncsure.com'),
        ('SYNC-DEMO-456', 'active', 5, 'demo@syncsure.com'),
        ('SYNC-PROD-789', 'active', 25, 'customer@syncsure.com')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Create test user account
    const testUserExists = await client.query('SELECT id FROM users WHERE email = $1', ['test@syncsure.com']);
    if (testUserExists.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(
        'INSERT INTO users (email, pw_hash) VALUES ($1, $2)',
        ['test@syncsure.com', hashedPassword]
      );
      console.log('✅ Created test user: test@syncsure.com / password123');
    }

    console.log('✅ Database schema setup complete!');
    
  } catch (err) {
    console.error('❌ Error during schema setup:', err);
  } finally {
    client.release();
  }
}

// Run the schema check on startup
ensureSchema().catch(console.error);

// ---------- GLOBAL CORS CONFIGURATION ----------
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://sync-sure-agents5.replit.app';

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow your frontend origin
    if (origin === FRONTEND_ORIGIN) {
      return callback(null, true);
    }
    
    // Allow Replit domains
    if (origin.endsWith('.replit.app') || origin.endsWith('.replit.dev')) {
      return callback(null, true);
    }
    
    // Allow any origin for non-auth routes (heartbeat, etc.)
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'User-Agent', 'Origin', 'Accept'],
  exposedHeaders: ['Set-Cookie']
}));

// Handle preflight requests
app.options('*', cors());

// ---------- Session Configuration ----------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
app.use(session({
  name: 'syncsure.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,      // not available to JS
    secure: process.env.NODE_ENV === 'production', // secure in production
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // cross-site in production
    maxAge: 7 * 24 * 3600 * 1000 // 7 days
  }
}));

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------- Event Catalog + Normalization ----------
const EventCatalog = {
  // Critical Failures → error
  process_missing:    { status: 'error',  eventType: 'process_missing',    description: 'OneDrive process not running' },
  auth_error:         { status: 'error',  eventType: 'auth_error',         description: 'Authentication / login errors' },
  sync_blocked:       { status: 'error',  eventType: 'sync_blocked',       description: 'Sync blocked (paused/denied)' },
  connectivity_fail:  { status: 'error',  eventType: 'connectivity_fail',  description: 'Connectivity failure to OneDrive endpoints' },
  file_errors_high:   { status: 'error',  eventType: 'file_errors_high',   description: 'Large number of file errors' },
  disk_full:          { status: 'error',  eventType: 'disk_full',          description: 'Disk full / quota exceeded' },

  // Warnings → warn
  pending_long:       { status: 'warn',   eventType: 'pending_long',       description: 'Sync stuck / long pending' },
  partial_errors:     { status: 'warn',   eventType: 'partial_errors',     description: 'A few file sync errors (1–5)' },
  network_hiccup:     { status: 'warn',   eventType: 'network_hiccup',     description: 'Temporary network hiccup' },
  heartbeat_unknown:  { status: 'warn',   eventType: 'heartbeat_unknown',  description: 'Tool heartbeat seen, but unknown state' },

  // Healthy → ok
  process_running:    { status: 'ok',     eventType: 'process_running',    description: 'OneDrive process is running' },
  healthy:            { status: 'ok',     eventType: 'healthy',            description: 'Everything looks good' },

  // Device state → asleep
  device_asleep:      { status: 'asleep', eventType: 'device_asleep',      description: 'Agent reports system sleep' },
  device_shutdown:    { status: 'asleep', eventType: 'device_shutdown',    description: 'Agent reports shutdown' },
};

function normalizeEvent(inputStatus, inputEventType) {
  const key = String((inputEventType || '').toLowerCase().trim());
  if (EventCatalog[key]) return EventCatalog[key];

  const aliases = {
    'onedrive_running': 'process_running',
    'onedrive_missing': 'process_missing',
    'auth_failed':      'auth_error',
    'net_fail':         'connectivity_fail',
    'errors_high':      'file_errors_high',
    'errors_some':      'partial_errors',
    'stuck_pending':    'pending_long',
    'asleep':           'device_asleep',
    'shutdown':         'device_shutdown',
  };
  if (aliases[key] && EventCatalog[aliases[key]]) {
    return EventCatalog[aliases[key]];
  }

  const s = String((inputStatus || '').toLowerCase().trim());
  if (['ok','warn','error','asleep'].includes(s)) {
    return { status: s, eventType: key || 'unknown' };
  }

  return { status: 'warn', eventType: key || 'unknown' };
}

// ---------- Shared heartbeat insert ----------
async function handleHeartbeatInsert(client, {
  licenseKey, deviceHash, rawStatus, rawEventType, message, errorDetail
}) {
  if (!licenseKey || !deviceHash) {
    return { http: 400, body: { error: 'Missing licenseKey/deviceHash' } };
  }

  // license
  const lic = await client.query(
    `select id, status, max_devices from licenses where key=$1 limit 1`,
    [licenseKey]
  );
  if (lic.rows.length === 0) return { http: 401, body: { error: 'License not found' } };
  const L = lic.rows[0];
  if ((L.status || 'active') !== 'active') return { http: 403, body: { error: `License ${L.status}` } };

  // binding + seats
  const bound = await client.query(
    `select 1 from license_bindings where license_id=$1 and device_hash=$2 limit 1`,
    [L.id, deviceHash]
  );
  if (bound.rows.length === 0) {
    const cnt = await client.query(
      `select count(*)::int as c from license_bindings where license_id=$1`,
      [L.id]
    );
    if (cnt.rows[0].c >= (L.max_devices || 1)) {
      return { http: 403, body: { error: 'Seat limit reached' } };
    }
    await client.query(
      `insert into license_bindings(license_id, device_hash)
       values($1,$2)
       on conflict (license_id, device_hash) do nothing`,
      [L.id, deviceHash]
    );
  }

  // normalize + insert
  const normalized = normalizeEvent(rawStatus, rawEventType);
  const finalStatus    = normalized.status;
  const finalEventType = normalized.eventType;

  await client.query(
    `insert into heartbeats(license_id, device_hash, status, event_type, message, error_detail)
     values($1,$2,$3,$4,$5,$6)`,
    [L.id, deviceHash, finalStatus, finalEventType, message || null, errorDetail ?? null]
  );

  return { http: 200, body: { ok: true, normalized: { status: finalStatus, eventType: finalEventType } } };
}

// ---------- Authentication Routes ----------
app.post('/api/auth/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    
    // Check if user already exists
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const result = await client.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
    );
    
    const user = result.rows[0];
    req.session.userId = user.id;
    
    res.json({ user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    
    // Get user
    const result = await client.query('SELECT id, email, password, created_at FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    // Verify password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // Set session
    req.session.userId = user.id;
    
    // Return user without password
    const { password: userPassword, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.session.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: 'Could not log out' });
    }
    res.json({ success: true });
  });
});

// ---------- Dashboard Stats Route ----------
app.get('/api/dashboard/stats', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const client = await pool.connect();
  try {
    // Get user's email to find their licenses
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userEmail = userResult.rows[0].email;

    // Get licenses for this user (you may want to adjust this logic)
    const licensesResult = await client.query('SELECT id, max_devices FROM licenses WHERE customer_email = $1 OR $1 = $2', [userEmail, 'test@syncsure.com']);
    
    if (licensesResult.rows.length === 0) {
      return res.json({
        totalDevices: 0,
        activeDevices: 0,
        healthyDevices: 0,
        warningDevices: 0,
        errorDevices: 0,
        asleepDevices: 0,
        seatsUsed: 0,
        seatsTotal: 0,
        lastUpdate: new Date().toISOString()
      });
    }

    const licenseIds = licensesResult.rows.map(l => l.id);
    const seatsTotal = licensesResult.rows.reduce((sum, l) => sum + l.max_devices, 0);

    // Get latest heartbeat status for each device in last 10 minutes
    const heartbeatsResult = await client.query(`
      SELECT DISTINCT ON (device_hash) device_hash, status, created_at
      FROM heartbeats 
      WHERE license_id = ANY($1) AND created_at > NOW() - INTERVAL '10 minutes'
      ORDER BY device_hash, created_at DESC
    `, [licenseIds]);

    const stats = {
      totalDevices: 0,
      activeDevices: 0,
      healthyDevices: 0,
      warningDevices: 0,
      errorDevices: 0,
      asleepDevices: 0,
      seatsUsed: 0,
      seatsTotal,
      lastUpdate: new Date().toISOString()
    };

    heartbeatsResult.rows.forEach(heartbeat => {
      stats.totalDevices++;
      stats.activeDevices++;

      switch (heartbeat.status) {
        case 'ok':
          stats.healthyDevices++;
          break;
        case 'warn':
          stats.warningDevices++;
          break;
        case 'error':
          stats.errorDevices++;
          break;
        case 'asleep':
          stats.asleepDevices++;
          break;
      }
    });

    // Get seats used
    const seatsResult = await client.query('SELECT COUNT(*) as count FROM license_bindings WHERE license_id = ANY($1)', [licenseIds]);
    stats.seatsUsed = parseInt(seatsResult.rows[0].count) || 0;

    res.json(stats);
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Heartbeats Route ----------
app.get('/api/heartbeats', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const { licenseKey } = req.query;
  if (!licenseKey) {
    return res.status(400).json({ message: 'License key required' });
  }

  const client = await pool.connect();
  try {
    // Get license
    const licenseResult = await client.query('SELECT id FROM licenses WHERE key = $1', [licenseKey]);
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ message: 'License not found' });
    }

    const licenseId = licenseResult.rows[0].id;

    // Get latest heartbeat for each device
    const devicesResult = await client.query(`
      SELECT DISTINCT ON (device_hash) 
        device_hash,
        status as last_status,
        event_type as last_event_type,
        message as last_message,
        created_at as last_seen
      FROM heartbeats 
      WHERE license_id = $1 
      ORDER BY device_hash, created_at DESC
    `, [licenseId]);

    res.json({ devices: devicesResult.rows });
  } catch (error) {
    console.error('Heartbeats error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Agent heartbeat route ----------
app.post('/api/heartbeat', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, status, eventType, message, errorDetail } = req.body || {};
    const result = await handleHeartbeatInsert(client, {
      licenseKey, deviceHash, rawStatus: status, rawEventType: eventType, message, errorDetail
    });
    res.status(result.http).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- License routes ----------
app.get('/api/licenses', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const client = await pool.connect();
  try {
    // Get user email
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userEmail = userResult.rows[0].email;

    // Get licenses for this user
    const licensesResult = await client.query(`
      SELECT l.*, 
        COUNT(lb.device_hash) as devices_count
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id
      WHERE l.customer_email = $1 OR $1 = $2
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [userEmail, 'test@syncsure.com']);

    res.json(licensesResult.rows);
  } catch (error) {
    console.error('Licenses error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// ---------- Start server ----------
const PORT = parseInt(process.env.PORT || '5000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SyncSure Backend running on port ${PORT}`);
});



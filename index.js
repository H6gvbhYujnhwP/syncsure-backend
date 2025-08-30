// index.js
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
    
    // Create the users table if it doesn't exist
    await client.query(`
      create table if not exists users (
        id          bigserial primary key,
        email       text not null unique,
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

    // Create licenses table with basic structure first
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id BIGSERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Add missing columns to licenses table if they don't exist
    const licenseColumns = [
      { name: 'customer_email', type: 'VARCHAR(255)' },
      { name: 'stripe_customer_id', type: 'VARCHAR(255)' },
      { name: 'stripe_subscription_id', type: 'VARCHAR(255)' },
      { name: 'updated_at', type: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'expires_at', type: 'TIMESTAMPTZ NULL' }
    ];

    for (const col of licenseColumns) {
      const colExists = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='licenses' AND column_name=$1
      `, [col.name]);
      
      if (colExists.rowCount === 0) {
        console.log(`Adding missing "${col.name}" column to licenses table...`);
        await client.query(`ALTER TABLE licenses ADD COLUMN ${col.name} ${col.type};`);
      }
    }

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

    // Insert test licenses (only basic columns)
    await client.query(`
      INSERT INTO licenses (key, status, max_devices) VALUES
        ('SYNC-TEST-123', 'active', 10),
        ('SYNC-DEMO-456', 'active', 5),
        ('SYNC-PROD-789', 'active', 25)
      ON CONFLICT (key) DO NOTHING;
    `);

    // Update customer_email for test licenses if column exists
    const emailColExists = await client.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='licenses' AND column_name='customer_email'
    `);
    
    if (emailColExists.rowCount > 0) {
      await client.query(`
        UPDATE licenses SET customer_email = 'test@example.com' WHERE key = 'SYNC-TEST-123' AND customer_email IS NULL;
        UPDATE licenses SET customer_email = 'demo@example.com' WHERE key = 'SYNC-DEMO-456' AND customer_email IS NULL;
        UPDATE licenses SET customer_email = 'customer@example.com' WHERE key = 'SYNC-PROD-789' AND customer_email IS NULL;
      `);
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
// Your frontend's origin
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://sync-sure-agents5.replit.app';
if (!FRONTEND_ORIGIN) {
  console.warn('WARNING: FRONTEND_ORIGIN not set. Set it in Render env for correct CORS with cookies.');
}

// Global CORS middleware - this fixes the main issue
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow your frontend origin
    if (origin === FRONTEND_ORIGIN) {
      return callback(null, true);
    }
    
    // Allow any origin for non-auth routes (heartbeat, etc.)
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'User-Agent', 'Origin'],
  exposedHeaders: ['Set-Cookie']
}));

// Handle preflight requests
app.options('*', cors());

// ---------- Session Configuration ----------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
app.use('/api/auth', session({
  name: 'syncsure.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,      // not available to JS
    secure: true,        // required on https (Render is https)
    sameSite: 'none',    // allow cross-site (frontend → backend)
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

// ---------- Agent routes ----------
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

app.post('/api/heartbeat/offline', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, message, errorDetail, reason } = req.body || {};
    const mappedEvent = String((reason || '').toLowerCase()) === 'sleep' ? 'device_asleep' : 'device_shutdown';
    const result = await handleHeartbeatInsert(client, {
      licenseKey,
      deviceHash,
      rawStatus: 'asleep',
      rawEventType: mappedEvent,
      message: message || (mappedEvent === 'device_asleep' ? 'system sleep' : 'system shutdown'),
      errorDetail
    });
    res.status(result.http).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- Dashboard routes ----------
app.get('/api/heartbeats', async (req, res) => {
  const licenseKey = (req.query.licenseKey || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey is required' });

  const client = await pool.connect();
  try {
    const lic = await client.query(
      `select id from licenses where key=$1 limit 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(404).json({ error: 'License not found' });
    const licenseId = lic.rows[0].id;

    const candidates = ['created_at', 'created_ts', 'inserted_at', 'timestamp', 'ts'];
    const colCheck = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema='public' and table_name='heartbeats'
         and column_name = any($1)`,
      [candidates]
    );

    if (colCheck.rows.length === 0) {
      const rows = await client.query(
        `
        with ranked as (
          select device_hash, max(id) as max_id
          from heartbeats
          where license_id = $1
          group by device_hash
        )
        select
          h.device_hash,
          now() as last_seen,
          (array_agg(h.status      order by h.id desc))[1] as last_status,
          (array_agg(h.event_type  order by h.id desc))[1] as last_event_type,
          (array_agg(h.message     order by h.id desc))[1] as last_message
        from heartbeats h
        join ranked r on r.device_hash = h.device_hash and r.max_id = h.id
        where h.license_id = $1
        group by h.device_hash
        order by r.max_id desc
        `,
        [licenseId]
      );
      return res.json({ licenseKey, devices: rows.rows, note: 'No timestamp column found; ordered by id.' });
    }

    const tsCol = colCheck.rows[0].column_name;

    const rows = await client.query(
      `
      select
        h.device_hash,
        max(h.${tsCol}) as last_seen,
        (array_agg(h.status      order by h.${tsCol} desc))[1] as last_status,
        (array_agg(h.event_type  order by h.${tsCol} desc))[1] as last_event_type,
        (array_agg(h.message     order by h.${tsCol} desc))[1] as last_message
      from heartbeats h
      where h.license_id = $1
      group by h.device_hash
      order by last_seen desc
      `,
      [licenseId]
    );

    res.json({ licenseKey, devices: rows.rows, tsColumnUsed: tsCol });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- Auth routes (cookie-based) ----------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(`insert into users(email, pw_hash) values ($1, $2)`, [email.toLowerCase(), hash]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already exists' });
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const result = await pool.query(`select id, pw_hash from users where email=$1 limit 1`, [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.pw_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/auth/me', (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, userId });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('syncsure.sid', { path: '/api/auth' });
    res.json({ ok: true });
  });
});

// ---------- Dashboard Stats Route (FIXED) ----------
app.get('/api/dashboard/stats', async (req, res) => {
  const client = await pool.connect();
  try {
    // Get the latest status for each device across all licenses
    const candidates = ['created_at', 'created_ts', 'inserted_at', 'timestamp', 'ts'];
    const colCheck = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema='public' and table_name='heartbeats'
         and column_name = any($1)`,
      [candidates]
    );

    let statsQuery;
    if (colCheck.rows.length === 0) {
      // No timestamp column found, use id ordering
      statsQuery = `
        with latest_heartbeats as (
          select distinct on (device_hash) 
            device_hash, status, id
          from heartbeats
          order by device_hash, id desc
        )
        select 
          count(*) as total_devices,
          count(*) filter (where status = 'ok') as healthy_devices,
          count(*) filter (where status = 'warn') as warning_devices,
          count(*) filter (where status = 'error') as error_devices,
          count(*) filter (where status = 'asleep') as asleep_devices
        from latest_heartbeats
      `;
    } else {
      // Use timestamp column
      const tsCol = colCheck.rows[0].column_name;
      statsQuery = `
        with latest_heartbeats as (
          select distinct on (device_hash) 
            device_hash, status, ${tsCol}
          from heartbeats
          order by device_hash, ${tsCol} desc
        )
        select 
          count(*) as total_devices,
          count(*) filter (where status = 'ok') as healthy_devices,
          count(*) filter (where status = 'warn') as warning_devices,
          count(*) filter (where status = 'error') as error_devices,
          count(*) filter (where status = 'asleep') as asleep_devices
        from latest_heartbeats
      `;
    }

    const result = await client.query(statsQuery);
    const stats = result.rows[0];

    // Convert string counts to integers
    const totalDevices = parseInt(stats.total_devices) || 0;
    const healthyDevices = parseInt(stats.healthy_devices) || 0;
    const warningDevices = parseInt(stats.warning_devices) || 0;
    const errorDevices = parseInt(stats.error_devices) || 0;
    const asleepDevices = parseInt(stats.asleep_devices) || 0;

    // Calculate active devices (healthy + warning, excluding error and asleep)
    const activeDevices = healthyDevices + warningDevices;

    res.json({
      totalDevices,
      activeDevices,
      healthyDevices,
      warningDevices,
      errorDevices,
      asleepDevices,
      lastUpdate: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SyncSure backend running on port ${PORT}`);
});


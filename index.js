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

// ---------- Ensure users table exists (simple local auth) ----------
async function ensureUsersTable() {
  const sql = `
  create table if not exists users (
    id          bigserial primary key,
    email       text not null unique,
    pw_hash     text not null,
    created_at  timestamptz not null default now()
  );
  `;
  await pool.query(sql);
}
ensureUsersTable().catch(console.error);

// ---------- CORS ----------
// Agent → POST /api/heartbeat (no cookies)
app.use('/api/heartbeat', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat', cors());

// Agent → POST /api/heartbeat/offline (no cookies)
app.use('/api/heartbeat/offline', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat/offline', cors());

// Dashboard → GET /api/heartbeats (public read in your current flow)
app.use('/api/heartbeats', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('/api/heartbeats', cors());

// Dashboard → GET /api/events/catalog (public)
app.use('/api/events/catalog', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('/api/events/catalog', cors());

// ---------- Auth CORS + Sessions ----------
// Your frontend’s origin, e.g. https://sync-sure-agents5.replit.app
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
if (!FRONTEND_ORIGIN) {
  console.warn('WARNING: FRONTEND_ORIGIN not set. Set it in Render env for correct CORS with cookies.');
}

// Allow cookies from the frontend for auth routes
app.use('/api/auth', cors({
  origin: FRONTEND_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));
app.options('/api/auth', cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// Session cookie
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

// ---------- Events catalog ----------
app.get('/api/events/catalog', (_req, res) => {
  const list = Object.entries(EventCatalog).map(([key, v]) => ({
    eventType: v.eventType,
    status: v.status,
    description: v.description
  }));
  res.json({ events: list });
});

// ---------- Start ----------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

// index.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;

// --- DB connection (Render Postgres / Replit Postgres / Supabase) ---
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

const app = express();

// Parse JSON
app.use(bodyParser.json({ limit: '256kb' }));

// ---------- CORS ----------
// Agent → POST /api/heartbeat
app.use('/api/heartbeat', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat', cors());

// Agent → POST /api/heartbeat/offline (new)
app.use('/api/heartbeat/offline', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat/offline', cors());

// Dashboard → GET /api/heartbeats
app.use('/api/heartbeats', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('/api/heartbeats', cors());

// Dashboard → GET /api/events/catalog
app.use('/api/events/catalog', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('/api/events/catalog', cors());

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/**
 * Canonical event mapping
 * Normalizes any incoming event/status into:
 *   - status: ok | warn | error | asleep
 *   - eventType: standardized event name
 */
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

  // Aliases
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

  // Respect explicit status if provided
  const s = String((inputStatus || '').toLowerCase().trim());
  if (['ok','warn','error','asleep'].includes(s)) {
    return { status: s, eventType: key || 'unknown' };
  }

  // Default
  return { status: 'warn', eventType: key || 'unknown' };
}

/**
 * Core upsert logic used by both heartbeat routes
 */
async function handleHeartbeatInsert(client, {
  licenseKey, deviceHash, rawStatus, rawEventType, message, errorDetail
}) {
  if (!licenseKey || !deviceHash) {
    return { http: 400, body: { error: 'Missing licenseKey/deviceHash' } };
  }

  // 1) License lookup
  const lic = await client.query(
    `select id, status, max_devices from licenses where key=$1 limit 1`,
    [licenseKey]
  );
  if (lic.rows.length === 0) return { http: 401, body: { error: 'License not found' } };
  const L = lic.rows[0];
  if ((L.status || 'active') !== 'active') return { http: 403, body: { error: `License ${L.status}` } };

  // 2) Binding + seats
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
      // Optional: Insert alert row here
      // await client.query(`insert into alerts(license_id,severity,code,message) values ($1,'error','seat_overage','Seat limit reached')`, [L.id]);
      return { http: 403, body: { error: 'Seat limit reached' } };
    }
    await client.query(
      `insert into license_bindings(license_id, device_hash)
       values($1,$2)
       on conflict (license_id, device_hash) do nothing`,
      [L.id, deviceHash]
    );
  }

  // 3) Normalize and insert
  const normalized = normalizeEvent(rawStatus, rawEventType);
  const finalStatus    = normalized.status;    // ok | warn | error | asleep
  const finalEventType = normalized.eventType; // canonical event

  await client.query(
    `insert into heartbeats(license_id, device_hash, status, event_type, message, error_detail)
     values($1,$2,$3,$4,$5,$6)`,
    [L.id, deviceHash, finalStatus, finalEventType, message || null, errorDetail ?? null]
  );

  return { http: 200, body: { ok: true, normalized: { status: finalStatus, eventType: finalEventType } } };
}

// ---------- POST /api/heartbeat (agent) ----------
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

// ---------- POST /api/heartbeat/offline (agent, immediate asleep/shutdown) ----------
app.post('/api/heartbeat/offline', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, message, errorDetail, reason } = req.body || {};
    // reason can be: "sleep", "shutdown" (defaults to shutdown)
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

// ---------- GET /api/heartbeats (dashboard) ----------
app.get('/api/heartbeats', async (req, res) => {
  const licenseKey = (req.query.licenseKey || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey is required' });

  const client = await pool.connect();
  try {
    // License id
    const lic = await client.query(
      `select id from licenses where key=$1 limit 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(404).json({ error: 'License not found' });
    const licenseId = lic.rows[0].id;

    // Detect timestamp column
    const candidates = ['created_at', 'created_ts', 'inserted_at', 'timestamp', 'ts'];
    const colCheck = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema='public' and table_name='heartbeats'
         and column_name = any($1)`,
      [candidates]
    );

    if (colCheck.rows.length === 0) {
      // Fallback: order by id
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

// ---------- GET /api/events/catalog ----------
app.get('/api/events/catalog', (_req, res) => {
  const list = Object.entries(EventCatalog).map(([key, v]) => ({
    eventType: v.eventType,
    status: v.status,
    description: v.description
  }));
  res.json({ events: list });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

// index.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;

// --- DB connection (Supabase or Replit Postgres) ---
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

const app = express();

// Parse JSON for normal routes (not Stripe webhook)
app.use(bodyParser.json({ limit: '256kb' }));

// ---------- CORS ----------
// Allow your desktop agent → POST /api/heartbeat
app.use('/api/heartbeat', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat', cors());

// Allow your dashboard (browser) → GET /api/heartbeats
app.use('/api/heartbeats', cors({
  origin: (o, cb) => cb(null, true),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('/api/heartbeats', cors());

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------- POST /api/heartbeat (agent) ----------
app.post('/api/heartbeat', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, status, eventType, message, errorDetail } = req.body || {};
    if (!licenseKey || !deviceHash) return res.status(400).json({ error: 'Missing licenseKey/deviceHash' });

    // 1) License
    const lic = await client.query(
      `select id, status, max_devices from licenses where key=$1 limit 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(401).json({ error: 'License not found' });
    const L = lic.rows[0];
    if ((L.status || 'active') !== 'active') return res.status(403).json({ error: `License ${L.status}` });

    // 2) Bind + seats
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
        // (Optional) insert alert row here
        return res.status(403).json({ error: 'Seat limit reached' });
      }
      await client.query(
        `insert into license_bindings(license_id, device_hash)
         values($1,$2)
         on conflict (license_id, device_hash) do nothing`,
        [L.id, deviceHash]
      );
    }

    // 3) Heartbeat
    await client.query(
      `insert into heartbeats(license_id, device_hash, status, event_type, message, error_detail)
       values($1,$2,$3,$4,$5,$6)`,
      [L.id, deviceHash, status || 'ok', eventType || 'process_running', message || null, errorDetail ?? null]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- GET /api/heartbeats (dashboard) ----------
// Returns latest heartbeat per device for a license
// Query params: ?licenseKey=SYNC-TEST-123
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

    // Latest per device
    const rows = await client.query(
      `
      select
        h.device_hash,
        max(h.created_at) as last_seen,
        (array_agg(h.status      order by h.created_at desc))[1] as last_status,
        (array_agg(h.event_type  order by h.created_at desc))[1] as last_event_type,
        (array_agg(h.message     order by h.created_at desc))[1] as last_message
      from heartbeats h
      where h.license_id = $1
      group by h.device_hash
      order by last_seen desc
      `,
      [licenseId]
    );

    res.json({ licenseKey, devices: rows.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { pool } from './db.js';

const app = express();

// Parse JSON
app.use(bodyParser.json({ limit: '256kb' }));

// CORS: allow your Windows agent to call the API
app.use('/api/heartbeat', cors({
  origin: (o, cb) => cb(null, true),              // reflect any origin (desktop agent)
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','X-Requested-With','User-Agent','Origin'],
  credentials: false
}));
app.options('/api/heartbeat', cors());            // preflight (harmless even if not used)

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Heartbeat (camelCase body)
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

    // 2) Bind device (enforce seats)
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
        // Optional: also insert alert row here
        return res.status(403).json({ error: 'Seat limit reached' });
      }
      await client.query(
        `insert into license_bindings(license_id, device_hash)
         values($1,$2)
         on conflict (license_id, device_hash) do nothing`,
        [L.id, deviceHash]
      );
    }

    // 3) Insert heartbeat
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

// Start
const port = process.env.PORT || 10000; // Render sets PORT automatically
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

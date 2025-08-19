// index.js
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json()); // parse JSON bodies

// --- Supabase (use SERVICE ROLE in SUPABASE_KEY) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// --- Health check ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Heartbeat: header x-license-key; body { device_hash, error_detail, report? } ---
app.post('/api/heartbeat', async (req, res) => {
  try {
    // 0) Read + normalize key
    const licKey = (req.header('x-license-key') || '').trim().toUpperCase();
    if (!licKey) return res.status(401).json({ error: 'Missing license key' });

    // 1) Find license
    const q1 = supabase
      .from('licenses')
      .select('id, status, max_devices')
      .eq('key', licKey)
      .maybeSingle();
    const { data: lic, error: licErr } = await q1;
    if (licErr) { console.error('LicErr:', licErr); return res.status(500).json({ step: 'license lookup', error: licErr.message }); }
    if (!lic)   { console.error('Lic not found for', licKey); return res.status(401).json({ error: 'License not found' }); }
    if ((lic.status || 'active') !== 'active') return res.status(403).json({ error: `License ${lic.status}` });

    // 2) Validate body
    const { device_hash, error_detail } = req.body || {};
    if (!device_hash) return res.status(400).json({ error: 'Missing device_hash' });

    // 3) Already bound?
    const q2 = supabase
      .from('license_bindings')
      .select('device_hash')
      .eq('license_id', lic.id)
      .eq('device_hash', device_hash)
      .maybeSingle();
    const { data: bound, error: boundErr } = await q2;
    if (boundErr) { console.error('BoundErr:', boundErr); return res.status(500).json({ step: 'binding select', error: boundErr.message }); }

    // 4) If not bound, enforce seats and bind
    if (!bound) {
      const q3 = supabase
        .from('license_bindings')
        .select('*', { count: 'exact', head: true })
        .eq('license_id', lic.id);
      const { count, error: countErr } = await q3;
      if (countErr) { console.error('CountErr:', countErr); return res.status(500).json({ step: 'binding count', error: countErr.message }); }

      if ((count || 0) >= (lic.max_devices || 1)) {
        return res.status(403).json({ error: 'Seat limit reached' });
      }

      const q4 = supabase
        .from('license_bindings')
        .insert([{ license_id: lic.id, device_hash }]);
      const { error: bindErr } = await q4;
      if (bindErr) { console.error('BindErr:', bindErr); return res.status(500).json({ step: 'binding insert', error: bindErr.message }); }
    }

    // 5) Record heartbeat
    const q5 = supabase
      .from('heartbeats')
      .insert([{ license_id: lic.id, device_hash, error_detail: error_detail ?? null }]);
    const { error: hbErr } = await q5;
    if (hbErr) { console.error('HbErr:', hbErr); return res.status(500).json({ step: 'heartbeat insert', error: hbErr.message }); }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Unhandled error:', e);
    return res.status(500).json({ error: 'Server error', detail: e?.message });
  }
});

// --- Start server (Render sets PORT) ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

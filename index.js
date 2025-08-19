import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json()); // replaces body-parser

// Supabase client (use SERVICE ROLE key in SUPABASE_KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Heartbeat
app.post('/api/heartbeat', async (req, res) => {
  try {
    // 0) Read + normalize header
    const licKey = (req.header('x-license-key') || '').trim().toUpperCase();
    if (!licKey) return res.status(401).json({ error: 'Missing license key' });

    // 1) Find license
    const { data: lic, error: licErr } = await supabase
      .from('licenses')
      .select('id, status, max_devices')
      .eq('key', licKey)
      .maybeSingle();

    if (licErr)    return res.status(500).json({ error: licErr.message });
    if (!lic)      return res.status(401).json({ error: 'License not found' });
    if ((lic.status || 'active') !== 'active') {
      return res.status(403).json({ error: `License ${lic.status}` });
    }

    // 2) Validate body
    const { device_hash, error_detail } = req.body || {};
    if (!device_hash) return res.status(400).json({ error: 'Missing device_hash' });

    // 3) Already bound?
    const { data: bound } = await supabase
      .from('license_bindings')
      .select('device_hash')
      .eq('license_id', lic.id)
      .eq('device_hash', device_hash)
      .maybeSingle();

    // 4) If not bound, enforce seats and bind
    if (!bound) {
      const { count } = await supabase
        .from('license_bindings')
        .select('*', { count: 'exact', head: true })
        .eq('license_id', lic.id);

      if ((count || 0) >= (lic.max_devices || 1)) {
        return res.status(403).json({ error: 'Seat limit reached' });
      }

      const { error: bindErr } = await supabase
        .from('license_bindings')
        .insert([{ license_id: lic.id, device_hash }]);
      if (bindErr) return res.status(500).json({ error: 'Bind failed', detail: bindErr.message });
    }

    // 5) Record heartbeat
    const { error: hbErr } = await supabase
      .from('heartbeats')
      .insert([{ license_id: lic.id, device_hash, error_detail: error_detail ?? null }]);
    if (hbErr) return res.status(500).json({ error: 'Insert failed', detail: hbErr.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: e?.message });
  }
});

// Start server (Render provides PORT)
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SyncSure backend listening on port ${port}`));

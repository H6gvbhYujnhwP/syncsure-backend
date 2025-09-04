import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// List recent licenses
router.get("/", async (_req, res) => {
  try {
    const r = await pool.query(`
      select l.id, l.license_key, l.max_devices, l.bound_count, l.created_at,
             a.email as account_email
      from licenses l
      left join accounts a on a.id = l.account_id
      order by l.created_at desc
      limit 100
    `);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create license (TEST utility)
router.post("/", async (req, res) => {
  const { email, licenseKey, maxDevices } = req.body || {};
  if (!email || !licenseKey || !maxDevices) {
    return res.status(400).json({ ok: false, error: "email, licenseKey, maxDevices required" });
  }
  try {
    const acc = await pool.query(
      `insert into accounts (email, role)
       values ($1,'user')
       on conflict (email) do update set role = accounts.role
       returning id`,
      [email]
    );
    const accId = acc.rows[0].id;

    const lic = await pool.query(
      `insert into licenses (account_id, license_key, max_devices)
       values ($1,$2,$3)
       on conflict (license_key) do nothing
       returning *`,
      [accId, licenseKey, maxDevices]
    );

    res.json({ ok: true, created: lic.rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;


import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// List recent licenses
router.get("/", async (req, res) => {
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

// Create license with new pricing model
router.post("/", async (req, res) => {
  const { 
    email, 
    licenseKey, 
    maxDevices,
    planType,
    pricePerDevice,
    companyName,
    firstName,
    lastName,
    fullName
  } = req.body || {};

  // Validation
  if (!email || !licenseKey || !maxDevices) {
    return res.status(400).json({ ok: false, error: "email, licenseKey, maxDevices required" });
  }

  // Validate pricing plan
  const validatePricingPlan = (maxDevices, planType, pricePerDevice) => {
    if (maxDevices >= 1 && maxDevices <= 50) {
      return planType === 'starter' && pricePerDevice === 1.99;
    } else if (maxDevices >= 51 && maxDevices <= 500) {
      return planType === 'business' && pricePerDevice === 1.49;
    } else if (maxDevices > 500) {
      return planType === 'enterprise' && pricePerDevice === 0.99;
    }
    return false;
  };

  if (planType && pricePerDevice && !validatePricingPlan(maxDevices, planType, pricePerDevice)) {
    return res.status(400).json({ 
      ok: false, 
      error: "Invalid pricing plan. Check device limits and pricing tiers." 
    });
  }

  try {
    // Create or get account
    const acc = await pool.query(`
      insert into accounts (email, name, role)
      values ($1, $2, 'user')
      on conflict (email) do update set 
        name = EXCLUDED.name,
        updated_at = now()
      returning id
    `, [email, fullName || `${firstName} ${lastName}` || email]);

    const accId = acc.rows[0].id;

    // Create license with new pricing fields
    const lic = await pool.query(`
      insert into licenses (account_id, license_key, max_devices, plan_type, price_per_device, company_name)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (license_key) do nothing
      returning *
    `, [accId, licenseKey, maxDevices, planType || 'starter', pricePerDevice || 1.99, companyName]);

    if (lic.rows.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: "License key already exists" 
      });
    }

    res.json({ 
      ok: true, 
      created: lic.rows[0] || null,
      account: {
        id: accId,
        email: email,
        name: fullName || `${firstName} ${lastName}`,
        companyName: companyName
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;

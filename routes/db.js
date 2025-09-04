import express from "express";
import { pool } from "../db.js";

const router = express.Router();

router.get("/ping", async (_req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;


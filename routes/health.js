import express from "express";
import { ping } from "../db.js";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "syncsure-backend",
    ts: new Date().toISOString()
  });
});

router.get("/deep", async (_req, res) => {
  try {
    const now = await ping();
    res.json({ ok: true, db: "ok", now });
  } catch (e) {
    res.status(500).json({ ok: false, db: "error", error: e.message });
  }
});

export default router;


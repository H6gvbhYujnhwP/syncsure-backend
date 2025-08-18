import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "@supabase/supabase-js";

const { createClient } = pkg;

const app = express();
app.use(cors());
app.use(bodyParser.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
  res.send("SyncSure backend is running!");
});

app.post("/api/heartbeat", async (req, res) => {
  try {
    const { licenseKey } = req.body;

    if (!licenseKey) {
      return res.status(400).json({ error: "Missing license key" });
    }

    // validate license
    const { data: license, error } = await supabase
      .from("licenses")
      .select("id, key, status, max_devices")
      .eq("key", licenseKey)
      .single();

    if (error || !license) {
      return res.status(403).json({ error: "Invalid license key" });
    }

    if (license.status !== "active") {
      return res.status(403).json({ error: "License not active" });
    }

    // record heartbeat
    const { error: hbError } = await supabase
      .from("heartbeats")
      .insert({ license_id: license.id });

    if (hbError) {
      return res.status(500).json({ error: "Failed to insert heartbeat" });
    }

    res.json({ ok: true, message: "Heartbeat recorded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`SyncSure backend listening on port ${port}`);
});

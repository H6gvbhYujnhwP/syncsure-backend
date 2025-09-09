import { pool } from "./db.js";
import { triggerWorkflow, latestReleaseByTag } from "./services/github.js";
import { sendLicenseEmail } from "./services/email.js"
import { initializeDatabase } from "./scripts/deploy-init-db.js";

const TICK_MS = 60_000; // 1 minute
const WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE || "build.yml";

async function processQueuedBuild() {
  const { rows } = await pool.query(
    "select b.*, l.license_key, a.email from builds b " +
    "left join licenses l on l.id = b.license_id " +
    "left join accounts a on a.id = l.account_id " +
    "where b.status = 'queued' order by b.created_at asc limit 1"
  );
  if (rows.length === 0) return;

  const b = rows[0];
  console.log("🚀 Dispatching workflow for build:", b.id, "tag:", b.tag || "v1");

  try {
    await triggerWorkflow(WORKFLOW_FILE, "main", { 
      tag: b.tag || "v1.0.0",
      license_key: b.license_key
    });
    await pool.query("update builds set status='building', updated_at=now() where id=$1", [b.id]);
  } catch (e) {
    console.error("❌ GitHub dispatch failed:", e.message);
    await pool.query("update builds set status='failed', updated_at=now() where id=$1", [b.id]);
  }
}

async function processBuildingBuild() {
  const { rows } = await pool.query(
    "select b.*, l.license_key, a.email from builds b " +
    "left join licenses l on l.id = b.license_id " +
    "left join accounts a on a.id = l.account_id " +
    "where b.status = 'building' order by b.updated_at asc limit 1"
  );
  if (rows.length === 0) return;

  const b = rows[0];
  const tag = b.tag || "v1.0.0";

  try {
    const release = await latestReleaseByTag(tag);
    if (!release) {
      console.log("… no release yet for", tag);
      return; // try again next tick
    }

    // choose first asset (or refine by name)
    const asset = release.assets?.[0];
    if (!asset) {
      console.log("release found but no assets yet");
      return;
    }

    await pool.query(
      "update builds set status='released', release_url=$1, asset_name=$2, asset_api_url=$3, updated_at=now() where id=$4",
      [release.html_url, asset.name, asset.url, b.id]
    );

    // email customer
    if (b.email) {
      const downloadUrl = release.html_url;
      await sendLicenseEmail({ to: b.email, licenseKey: b.license_key, downloadUrl });
      console.log("📧 emailed", b.email, "for build", b.id);
    }
  } catch (e) {
    console.error("poll release error:", e.message);
  }
}

async function tick() {
  console.log("⏳ worker tick", new Date().toISOString());
  await processQueuedBuild();
  await processBuildingBuild();
}

async function startWorker() {
  try {
    console.log("🔄 Starting SyncSure Worker...");
    
    // Initialize database schema
    await initializeDatabase();
    
    // Start the worker loop
    setInterval(tick, TICK_MS);
    console.log("✅ SyncSure Worker started successfully");
    console.log(`⏰ Worker tick interval: ${TICK_MS}ms`);
    console.log(`📁 Workflow file: ${WORKFLOW_FILE}`);
    
    // Run first tick immediately
    await tick();
  } catch (error) {
    console.error("❌ Failed to start worker:", error.message);
    process.exit(1);
  }
}

startWorker();(tick, TICK_MS);
console.log("✅ worker started");


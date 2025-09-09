// routes/builds.js
import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// Get builds for a customer by email
router.get("/customer/:email", async (req, res) => {
  try {
    const { email } = req.params;
    
    const query = `
      select 
        b.id,
        b.status,
        b.tag,
        b.release_url,
        b.asset_name,
        b.asset_api_url,
        b.created_at,
        b.updated_at,
        l.license_key,
        l.max_devices
      from builds b
      join licenses l on l.id = b.license_id
      join accounts a on a.id = l.account_id
      where a.email = $1
      order by b.created_at desc
    `;
    
    const { rows } = await pool.query(query, [email]);
    
    res.json({
      success: true,
      builds: rows
    });
  } catch (error) {
    console.error("Error fetching customer builds:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch builds"
    });
  }
});

// Get download URL for a specific build
router.get("/download/:buildId", async (req, res) => {
  try {
    const { buildId } = req.params;
    
    const query = `
      select 
        b.release_url,
        b.asset_name,
        b.asset_api_url,
        b.status,
        l.license_key
      from builds b
      join licenses l on l.id = b.license_id
      where b.id = $1 and b.status = 'released'
    `;
    
    const { rows } = await pool.query(query, [buildId]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Build not found or not ready"
      });
    }
    
    const build = rows[0];
    
    res.json({
      success: true,
      download: {
        releaseUrl: build.release_url,
        assetName: build.asset_name,
        licenseKey: build.license_key
      }
    });
  } catch (error) {
    console.error("Error fetching build download:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch download"
    });
  }
});

// Direct download proxy for SyncSureAgent.exe
router.get("/download/:buildId/exe", async (req, res) => {
  try {
    const { buildId } = req.params;
    
    const query = `
      select 
        b.release_url,
        b.tag,
        b.status,
        l.license_key
      from builds b
      join licenses l on l.id = b.license_id
      where b.id = $1 and b.status = 'released'
    `;
    
    const { rows } = await pool.query(query, [buildId]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Build not found or not ready"
      });
    }
    
    const build = rows[0];
    
    // Construct direct download URL for SyncSureAgent.exe
    const exeUrl = build.release_url.replace('/releases/tag/', '/releases/download/') + '/SyncSureAgent.exe';
    
    // Fetch the file from GitHub and stream it to the client
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(exeUrl);
    
    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}: ${response.statusText}`);
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', 'attachment; filename="SyncSureAgent.exe"');
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream the file to the client
    response.body.pipe(res);
    
  } catch (error) {
    console.error("Error downloading exe file:", error);
    res.status(500).json({
      success: false,
      error: "Failed to download file"
    });
  }
});

// Direct download proxy for SHA256 hash file
router.get("/download/:buildId/hash", async (req, res) => {
  try {
    const { buildId } = req.params;
    
    const query = `
      select 
        b.release_url,
        b.tag,
        b.status,
        l.license_key
      from builds b
      join licenses l on l.id = b.license_id
      where b.id = $1 and b.status = 'released'
    `;
    
    const { rows } = await pool.query(query, [buildId]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Build not found or not ready"
      });
    }
    
    const build = rows[0];
    
    // Construct SHA256 file URL
    const hashUrl = build.release_url.replace('/releases/tag/', '/releases/download/') + '/SyncSureAgent.exe.sha256';
    
    // Fetch the hash file from GitHub
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(hashUrl);
    
    if (!response.ok) {
      throw new Error(`GitHub API responded with ${response.status}`);
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', 'attachment; filename="SyncSureAgent.exe.sha256"');
    res.setHeader('Content-Type', 'text/plain');
    
    // Stream the file to the client
    response.body.pipe(res);
    
  } catch (error) {
    console.error("Error downloading hash file:", error);
    res.status(500).json({
      success: false,
      error: "Failed to download hash file"
    });
  }
});

// Direct download proxy for PowerShell script
router.get("/download/:buildId/script", async (req, res) => {
  try {
    const { buildId } = req.params;
    
    const query = `
      select 
        b.release_url,
        b.tag,
        b.status,
        l.license_key,
        l.max_devices
      from builds b
      join licenses l on l.id = b.license_id
      where b.id = $1 and b.status = 'released'
    `;
    
    const { rows } = await pool.query(query, [buildId]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Build not found or not ready"
      });
    }
    
    const build = rows[0];
    
    // Construct PowerShell script URL
    const scriptUrl = build.release_url.replace('/releases/tag/', '/releases/download/') + '/deploy-syncsure-agent.ps1';
    
    // Fetch the script file from GitHub
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(scriptUrl);
    
    if (!response.ok) {
      throw new Error(`GitHub API responded with ${response.status}`);
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', 'attachment; filename="deploy-syncsure-agent.ps1"');
    res.setHeader('Content-Type', 'text/plain');
    
    // Stream the file to the client
    response.body.pipe(res);
    
  } catch (error) {
    console.error("Error downloading script file:", error);
    res.status(500).json({
      success: false,
      error: "Failed to download script file"
    });
  }
});

export default router;


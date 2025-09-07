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

export default router;


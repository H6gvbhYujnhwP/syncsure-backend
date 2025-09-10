import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// Prevent caching of agent-related data
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  next();
});

// POST /api/bind - Device binding endpoint
router.post("/bind", async (req, res) => {
  try {
    const { 
      licenseKey, LicenseKey,           // Support both camelCase and PascalCase
      deviceHash, DeviceHash,           // Support both camelCase and PascalCase
      deviceName, DeviceName,           // Support both camelCase and PascalCase
      agentVersion, AgentVersion,       // Support both camelCase and PascalCase
      platform, Platform,               // Support both camelCase and PascalCase
      operatingSystem, OperatingSystem, // Support both camelCase and PascalCase
      architecture, Architecture        // Support both camelCase and PascalCase
    } = req.body;

    // Support both field name formats (C# PascalCase and JavaScript camelCase)
    const actualLicenseKey = licenseKey || LicenseKey;
    const actualDeviceHash = deviceHash || DeviceHash;
    const actualDeviceName = deviceName || DeviceName;
    const actualAgentVersion = agentVersion || AgentVersion;
    const actualPlatform = platform || Platform;
    const actualOperatingSystem = operatingSystem || OperatingSystem;
    const actualArchitecture = architecture || Architecture;

    // Validate required fields
    if (!actualLicenseKey || !actualDeviceHash) {
      return res.status(400).json({ 
        success: false, 
        error: "License key and device hash are required" 
      });
    }

    // Validate license key format (SYNC-xxxxxxxxxx-xxxxxxxx)
    if (!actualLicenseKey.match(/^SYNC-[A-Za-z0-9]+-[A-Za-z0-9]+$/)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid license key format" 
      });
    }

    // Find license
    const licenseQuery = `
      SELECT id, max_devices, bound_count, account_id
      FROM licenses 
      WHERE license_key = $1
    `;
    const licenseResult = await pool.query(licenseQuery, [actualLicenseKey]);

    if (licenseResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid license key" 
      });
    }

    const license = licenseResult.rows[0];

    // Check if device already bound
    const existingBindingQuery = `
      SELECT id, status FROM device_bindings 
      WHERE license_id = $1 AND device_id = $2
    `;
    const existingResult = await pool.query(existingBindingQuery, [license.id, actualDeviceHash]);

    if (existingResult.rows.length > 0) {
      // Update existing binding
      const updateQuery = `
        UPDATE device_bindings 
        SET device_name = $1, agent_version = $2, last_heartbeat = NOW(), 
            status = 'active', system_info = $3
        WHERE license_id = $4 AND device_id = $5
        RETURNING id
      `;
      
      const systemInfo = {
        platform: actualPlatform || 'windows',
        operatingSystem: actualOperatingSystem || '',
        architecture: actualArchitecture || 'x64'
      };
      
      await pool.query(updateQuery, [
        actualDeviceName || null, 
        actualAgentVersion || null, 
        JSON.stringify(systemInfo),
        license.id, 
        actualDeviceHash
      ]);

      return res.json({ 
        success: true, 
        message: "Device binding updated successfully",
        deviceId: actualDeviceHash
      });
    }

    // Check device limit for new bindings
    if (license.bound_count >= license.max_devices) {
      return res.status(400).json({ 
        success: false, 
        error: `Device limit exceeded. Maximum ${license.max_devices} devices allowed.` 
      });
    }

    // Create new device binding
    const insertQuery = `
      INSERT INTO device_bindings (license_id, device_id, device_name, agent_version, 
                                  bound_at, last_heartbeat, status, system_info)
      VALUES ($1, $2, $3, $4, NOW(), NOW(), 'active', $5)
      RETURNING id
    `;
    
    const systemInfo = {
      platform: actualPlatform || 'windows',
      operatingSystem: actualOperatingSystem || '',
      architecture: actualArchitecture || 'x64'
    };
    
    const insertResult = await pool.query(insertQuery, [
      license.id, 
      actualDeviceHash, 
      actualDeviceName || null, 
      actualAgentVersion || null,
      JSON.stringify(systemInfo)
    ]);

    // Update bound count
    const updateCountQuery = `
      UPDATE licenses 
      SET bound_count = (
        SELECT COUNT(*) FROM device_bindings 
        WHERE license_id = $1 AND status = 'active'
      ), updated_at = NOW()
      WHERE id = $1
    `;
    await pool.query(updateCountQuery, [license.id]);

    // Log the binding event
    const auditQuery = `
      INSERT INTO audit_log (actor, account_id, license_id, event, context)
      VALUES ('agent', $1, $2, 'device_bound', $3)
    `;
    await pool.query(auditQuery, [
      license.account_id,
      license.id,
      JSON.stringify({
        device_id: actualDeviceHash,
        device_name: actualDeviceName,
        agent_version: actualAgentVersion,
        platform: actualPlatform,
        operating_system: actualOperatingSystem,
        architecture: actualArchitecture
      })
    ]);

    res.json({ 
      success: true, 
      message: "Device bound successfully",
      deviceId: actualDeviceHash,
      maxDevices: license.max_devices,
      boundCount: license.bound_count + 1
    });

  } catch (error) {
    console.error("Device binding error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during device binding" 
    });
  }
});

// POST /api/heartbeat - Device heartbeat endpoint
router.post("/heartbeat", async (req, res) => {
  try {
    const { 
      licenseKey, LicenseKey,           // Support both camelCase and PascalCase
      deviceHash, DeviceHash,           // Support both camelCase and PascalCase
      timestamp, Timestamp,             // Support both camelCase and PascalCase
      status, Status,                   // Support both camelCase and PascalCase
      systemMetrics, SystemMetrics,     // Support both camelCase and PascalCase
      agentVersion, AgentVersion        // Support both camelCase and PascalCase
    } = req.body;

    // Support both field name formats (C# PascalCase and JavaScript camelCase)
    const actualLicenseKey = licenseKey || LicenseKey;
    const actualDeviceHash = deviceHash || DeviceHash;
    const actualTimestamp = timestamp || Timestamp;
    const actualStatus = status || Status;
    const actualSystemMetrics = systemMetrics || SystemMetrics;
    const actualAgentVersion = agentVersion || AgentVersion;

    if (!actualLicenseKey || !actualDeviceHash) {
      return res.status(400).json({ 
        success: false, 
        error: "License key and device hash are required" 
      });
    }

    // Find device binding
    const bindingQuery = `
      SELECT db.id, db.license_id, l.account_id
      FROM device_bindings db
      JOIN licenses l ON db.license_id = l.id
      WHERE l.license_key = $1 AND db.device_id = $2 AND db.status = 'active'
    `;
    const bindingResult = await pool.query(bindingQuery, [actualLicenseKey, actualDeviceHash]);

    if (bindingResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Device not bound to this license" 
      });
    }

    const binding = bindingResult.rows[0];

    // Update heartbeat
    const updateQuery = `
      UPDATE device_bindings 
      SET last_heartbeat = NOW(), 
          agent_version = COALESCE($1, agent_version),
          system_info = COALESCE($2, system_info)
      WHERE id = $3
    `;
    await pool.query(updateQuery, [
      actualAgentVersion,
      actualSystemMetrics ? JSON.stringify(actualSystemMetrics) : null,
      binding.id
    ]);

    // Update license last_sync
    await pool.query(
      "UPDATE licenses SET last_sync = NOW() WHERE id = $1",
      [binding.license_id]
    );

    res.json({ 
      success: true, 
      message: "Heartbeat received",
      timestamp: new Date().toISOString(),
      commands: [] // Future: server commands for the agent
    });

  } catch (error) {
    console.error("Heartbeat error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during heartbeat" 
    });
  }
});

// GET /api/agent/latest - Agent update check endpoint
router.get("/latest", async (req, res) => {
  try {
    const { arch, current } = req.query;

    // For now, return no update available
    // In the future, this would check GitHub releases for the latest version
    const latestVersion = "1.0.0.0"; // This should come from GitHub API

    if (current === latestVersion) {
      return res.json({
        updateAvailable: false,
        currentVersion: current,
        latestVersion: latestVersion
      });
    }

    // If update is available (future implementation)
    res.json({
      updateAvailable: false, // Set to true when updates are available
      currentVersion: current,
      latestVersion: latestVersion,
      downloadUrl: null, // Future: GitHub release download URL
      releaseNotes: null // Future: Release notes
    });

  } catch (error) {
    console.error("Agent update check error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during update check" 
    });
  }
});

// GET /api/agent/status - Agent status endpoint for debugging
router.get("/status", async (req, res) => {
  try {
    const { licenseKey } = req.query;

    if (!licenseKey) {
      return res.status(400).json({ error: "License key required" });
    }

    // Get license and device information
    const statusQuery = `
      SELECT 
        l.license_key,
        l.max_devices,
        l.bound_count,
        l.last_sync,
        COUNT(db.id) as active_devices,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'device_id', db.device_id,
            'device_name', db.device_name,
            'agent_version', db.agent_version,
            'last_heartbeat', db.last_heartbeat,
            'status', db.status
          )
        ) FILTER (WHERE db.id IS NOT NULL) as devices
      FROM licenses l
      LEFT JOIN device_bindings db ON l.id = db.license_id
      WHERE l.license_key = $1
      GROUP BY l.id, l.license_key, l.max_devices, l.bound_count, l.last_sync
    `;
    const result = await pool.query(statusQuery, [licenseKey]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "License not found" });
    }

    res.json({
      success: true,
      license: result.rows[0]
    });

  } catch (error) {
    console.error("Agent status error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
});

export default router;


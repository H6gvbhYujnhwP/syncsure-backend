import express from "express";
import { pool } from "../db.js";
import { fieldNameNormalizer, extractFields } from "../middleware/fieldNameNormalizer.js";
import { agentOperationLogger, heartbeatMonitor, performanceLogger } from "../middleware/logging.js";

const router = express.Router();

// Apply field name normalization middleware to all agent routes
router.use(fieldNameNormalizer);

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
  const startTime = Date.now();
  
  try {
    // Extract fields using the field name normalizer helper
    const {
      licenseKey,
      deviceHash,
      deviceName,
      agentVersion,
      platform,
      operatingSystem,
      architecture
    } = extractFields(req.body, [
      'licenseKey',
      'deviceHash', 
      'deviceName',
      'agentVersion',
      'platform',
      'operatingSystem',
      'architecture'
    ]);

    // Log bind attempt
    await agentOperationLogger('device_bind_attempt', {
      licenseKey: licenseKey ? `${licenseKey.substring(0, 10)}...` : null,
      deviceHash: deviceHash ? `${deviceHash.substring(0, 8)}...` : null,
      deviceName,
      agentVersion,
      platform,
      operatingSystem,
      architecture
    });

    // Validate required fields
    if (!licenseKey || !deviceHash) {
      await agentOperationLogger('device_bind_validation_failed', {
        licenseKey: !!licenseKey,
        deviceHash: !!deviceHash,
        reason: 'missing_required_fields'
      }, false);
      
      return res.status(400).json({ 
        success: false, 
        error: "License key and device hash are required" 
      });
    }

    // Validate license key format (SYNC-xxxxxxxxxx-xxxxxxxx)
    if (!licenseKey.match(/^SYNC-[A-Za-z0-9]+-[A-Za-z0-9]+$/)) {
      await agentOperationLogger('device_bind_validation_failed', {
        licenseKey: `${licenseKey.substring(0, 10)}...`,
        reason: 'invalid_license_format'
      }, false);
      
      return res.status(400).json({ 
        success: false, 
        error: "Invalid license key format" 
      });
    }

    // Find license
    const licenseQuery = `
      SELECT id, device_count, bound_count, account_id, pricing_tier
      FROM licenses 
      WHERE license_key = $1
    `;
    const licenseResult = await pool.query(licenseQuery, [licenseKey]);

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
    const existingResult = await pool.query(existingBindingQuery, [license.id, deviceHash]);

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
        platform: platform || 'windows',
        operatingSystem: operatingSystem || '',
        architecture: architecture || 'x64'
      };
      
      await pool.query(updateQuery, [
        deviceName || null, 
        agentVersion || null, 
        JSON.stringify(systemInfo),
        license.id, 
        deviceHash
      ]);

      return res.json({ 
        success: true, 
        message: "Device binding updated successfully",
        deviceId: deviceHash
      });
    }

    // Check device limit for new bindings
    if (license.bound_count >= license.device_count) {
      return res.status(400).json({ 
        success: false, 
        error: `Device limit exceeded. Maximum ${license.device_count} devices allowed for ${license.pricing_tier}.` 
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
      platform: platform || 'windows',
      operatingSystem: operatingSystem || '',
      architecture: architecture || 'x64'
    };
    
    const insertResult = await pool.query(insertQuery, [
      license.id, 
      deviceHash, 
      deviceName || null, 
      agentVersion || null,
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
        device_id: deviceHash,
        device_name: deviceName,
        agent_version: agentVersion,
        platform: platform,
        operating_system: operatingSystem,
        architecture: architecture
      })
    ]);

    // Log successful bind operation
    const duration = Date.now() - startTime;
    await agentOperationLogger('device_bind_success', {
      licenseKey: `${licenseKey.substring(0, 10)}...`,
      deviceHash: `${deviceHash.substring(0, 8)}...`,
      deviceName,
      agentVersion,
      pricingTier: license.pricing_tier,
      boundCount: license.bound_count + 1,
      duration
    });

    // Log performance
    performanceLogger('device_bind', duration, {
      licenseId: license.id,
      deviceCount: license.device_count,
      boundCount: license.bound_count + 1
    });

    res.json({ 
      success: true, 
      message: "Device bound successfully",
      deviceId: deviceHash,
      pricingTier: license.pricing_tier,
      deviceCount: license.device_count,
      boundCount: license.bound_count + 1
    });

  } catch (error) {
    console.error("Device binding error:", error);
    
    // Log bind error
    await agentOperationLogger('device_bind_error', {
      licenseKey: licenseKey ? `${licenseKey.substring(0, 10)}...` : null,
      deviceHash: deviceHash ? `${deviceHash.substring(0, 8)}...` : null,
      error: error.message
    }, false, error);
    
    res.status(500).json({ 
      success: false, 
      error: "Internal server error during device binding" 
    });
  }
});

// POST /api/heartbeat - Device heartbeat endpoint
router.post("/heartbeat", async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Extract fields using the field name normalizer helper
    const {
      licenseKey,
      deviceHash,
      timestamp,
      status,
      systemMetrics,
      agentVersion
    } = extractFields(req.body, [
      'licenseKey',
      'deviceHash',
      'timestamp',
      'status',
      'systemMetrics',
      'agentVersion'
    ]);

    // Log heartbeat attempt
    await agentOperationLogger('device_heartbeat_attempt', {
      licenseKey: licenseKey ? `${licenseKey.substring(0, 10)}...` : null,
      deviceHash: deviceHash ? `${deviceHash.substring(0, 8)}...` : null,
      timestamp,
      status,
      agentVersion
    });

    if (!licenseKey || !deviceHash) {
      await agentOperationLogger('device_heartbeat_validation_failed', {
        licenseKey: !!licenseKey,
        deviceHash: !!deviceHash,
        reason: 'missing_required_fields'
      }, false);
      
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
    const bindingResult = await pool.query(bindingQuery, [licenseKey, deviceHash]);

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
      agentVersion,
      systemMetrics ? JSON.stringify(systemMetrics) : null,
      binding.id
    ]);

    // Update license last_sync
    await pool.query(
      "UPDATE licenses SET last_sync = NOW() WHERE id = $1",
      [binding.license_id]
    );

    // Log successful heartbeat
    const duration = Date.now() - startTime;
    await agentOperationLogger('device_heartbeat_success', {
      licenseKey: `${licenseKey.substring(0, 10)}...`,
      deviceHash: `${deviceHash.substring(0, 8)}...`,
      agentVersion,
      duration
    });

    // Log heartbeat to monitoring system
    await heartbeatMonitor.logHeartbeat(binding.license_id, deviceHash, true, {
      agentVersion,
      systemMetrics: systemMetrics ? 'provided' : 'not_provided',
      duration
    });

    // Log performance
    performanceLogger('device_heartbeat', duration, {
      licenseId: binding.license_id,
      hasSystemMetrics: !!systemMetrics
    });

    res.json({ 
      success: true, 
      message: "Heartbeat received",
      timestamp: new Date().toISOString(),
      commands: [] // Future: server commands for the agent
    });

  } catch (error) {
    console.error("Heartbeat error:", error);
    
    // Log heartbeat error
    await agentOperationLogger('device_heartbeat_error', {
      licenseKey: licenseKey ? `${licenseKey.substring(0, 10)}...` : null,
      deviceHash: deviceHash ? `${deviceHash.substring(0, 8)}...` : null,
      error: error.message
    }, false, error);
    
    // Log failed heartbeat to monitoring system
    if (licenseKey && deviceHash) {
      try {
        const licenseResult = await pool.query(
          "SELECT id FROM licenses WHERE license_key = $1",
          [licenseKey]
        );
        if (licenseResult.rows.length > 0) {
          await heartbeatMonitor.logHeartbeat(licenseResult.rows[0].id, deviceHash, false, {
            error: error.message
          });
        }
      } catch (monitorError) {
        console.error("Heartbeat monitoring error:", monitorError);
      }
    }
    
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
        l.device_count,
        l.bound_count,
        l.pricing_tier,
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
      GROUP BY l.id, l.license_key, l.device_count, l.bound_count, l.pricing_tier, l.last_sync
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


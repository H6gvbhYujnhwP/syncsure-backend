import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// Prevent caching of dashboard data
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  next();
});

// GET /api/dashboard/devices - Get devices for authenticated user
router.get("/devices", async (req, res) => {
  try {
    // For now, get license key from query param
    // TODO: Replace with authenticated user's license lookup
    const { licenseKey } = req.query;
    
    if (!licenseKey) {
      return res.status(400).json({ 
        success: false, 
        error: "License key required" 
      });
    }

    // Get license information
    const licenseQuery = `
      SELECT 
        l.id,
        l.license_key,
        l.max_devices,
        l.bound_count,
        l.last_sync,
        l.status as license_status,
        a.email as account_email
      FROM licenses l
      LEFT JOIN accounts a ON l.account_id = a.id
      WHERE l.license_key = $1 AND l.status = 'active'
    `;
    
    const licenseResult = await pool.query(licenseQuery, [licenseKey]);
    
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: "License not found or inactive" 
      });
    }

    const license = licenseResult.rows[0];

    // Get devices bound to this license
    const devicesQuery = `
      SELECT 
        db.device_id,
        db.device_name,
        db.agent_version,
        db.last_heartbeat,
        db.status,
        db.bound_at,
        db.license_key_source,
        db.system_info
      FROM device_bindings db
      WHERE db.license_id = $1
      ORDER BY db.last_heartbeat DESC NULLS LAST
    `;
    
    const devicesResult = await pool.query(devicesQuery, [license.id]);

    // Calculate active devices (heartbeat within last 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const activeDevices = devicesResult.rows.filter(device => 
      device.last_heartbeat && new Date(device.last_heartbeat) > thirtyMinutesAgo
    ).length;

    // Format response for dashboard
    const response = {
      success: true,
      license: {
        license_key: license.license_key,
        max_devices: license.max_devices,
        bound_count: license.bound_count,
        active_devices: activeDevices,
        last_sync: license.last_sync,
        status: license.license_status,
        account_email: license.account_email
      },
      devices: devicesResult.rows.map(device => ({
        device_id: device.device_id,
        device_name: device.device_name || 'Unknown Device',
        agent_version: device.agent_version,
        last_heartbeat: device.last_heartbeat,
        status: device.status,
        bound_at: device.bound_at,
        license_key_source: device.license_key_source,
        system_info: device.system_info,
        is_active: device.last_heartbeat && new Date(device.last_heartbeat) > thirtyMinutesAgo
      })),
      stats: {
        total_devices: devicesResult.rows.length,
        active_devices: activeDevices,
        inactive_devices: devicesResult.rows.length - activeDevices,
        max_devices: license.max_devices,
        utilization_percentage: Math.round((devicesResult.rows.length / license.max_devices) * 100)
      }
    };

    res.json(response);

  } catch (error) {
    console.error("Dashboard devices error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
});

// GET /api/dashboard/stats - Get dashboard statistics
router.get("/stats", async (req, res) => {
  try {
    const { licenseKey } = req.query;
    
    if (!licenseKey) {
      return res.status(400).json({ 
        success: false, 
        error: "License key required" 
      });
    }

    // Get license and device statistics
    const statsQuery = `
      SELECT 
        l.license_key,
        l.max_devices,
        l.bound_count,
        l.last_sync,
        COUNT(db.id) as total_devices,
        COUNT(CASE WHEN db.last_heartbeat > NOW() - INTERVAL '30 minutes' THEN 1 END) as active_devices,
        COUNT(CASE WHEN db.status = 'active' THEN 1 END) as healthy_devices,
        MAX(db.last_heartbeat) as latest_heartbeat
      FROM licenses l
      LEFT JOIN device_bindings db ON l.id = db.license_id
      WHERE l.license_key = $1 AND l.status = 'active'
      GROUP BY l.id, l.license_key, l.max_devices, l.bound_count, l.last_sync
    `;
    
    const statsResult = await pool.query(statsQuery, [licenseKey]);
    
    if (statsResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: "License not found" 
      });
    }

    const stats = statsResult.rows[0];

    res.json({
      success: true,
      stats: {
        license_key: stats.license_key,
        max_devices: parseInt(stats.max_devices),
        bound_count: parseInt(stats.bound_count),
        total_devices: parseInt(stats.total_devices),
        active_devices: parseInt(stats.active_devices),
        healthy_devices: parseInt(stats.healthy_devices),
        inactive_devices: parseInt(stats.total_devices) - parseInt(stats.active_devices),
        utilization_percentage: Math.round((parseInt(stats.total_devices) / parseInt(stats.max_devices)) * 100),
        last_sync: stats.last_sync,
        latest_heartbeat: stats.latest_heartbeat
      }
    });

  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
});

// GET /api/dashboard/heartbeats - Get heartbeat data for charts
router.get("/heartbeats", async (req, res) => {
  try {
    const { licenseKey, hours = 24 } = req.query;
    
    if (!licenseKey) {
      return res.status(400).json({ 
        success: false, 
        error: "License key required" 
      });
    }

    // Get heartbeat data for the specified time period
    const heartbeatQuery = `
      SELECT 
        db.device_id,
        db.device_name,
        db.last_heartbeat,
        db.status,
        al.timestamp,
        al.action,
        al.details
      FROM device_bindings db
      LEFT JOIN licenses l ON db.license_id = l.id
      LEFT JOIN audit_log al ON al.license_key = l.license_key 
        AND al.action = 'heartbeat' 
        AND al.timestamp > NOW() - INTERVAL '${parseInt(hours)} hours'
      WHERE l.license_key = $1
      ORDER BY al.timestamp DESC
    `;
    
    const heartbeatResult = await pool.query(heartbeatQuery, [licenseKey]);

    // Group heartbeats by device and time
    const heartbeatData = heartbeatResult.rows.reduce((acc, row) => {
      if (!row.timestamp) return acc;
      
      const deviceId = row.device_id;
      if (!acc[deviceId]) {
        acc[deviceId] = {
          device_id: deviceId,
          device_name: row.device_name || 'Unknown Device',
          status: row.status,
          heartbeats: []
        };
      }
      
      acc[deviceId].heartbeats.push({
        timestamp: row.timestamp,
        action: row.action,
        details: row.details
      });
      
      return acc;
    }, {});

    res.json({
      success: true,
      heartbeat_data: Object.values(heartbeatData),
      time_range_hours: parseInt(hours)
    });

  } catch (error) {
    console.error("Dashboard heartbeats error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
});

export default router;


// index.js - Complete SyncSure Backend with Device Management + Migration Endpoint
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import pkg from 'pg';
import cron from 'node-cron';
import { Resend } from 'resend';

const { Pool } = pkg;

// ---------- Configuration ----------
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@syncsure.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'SyncSure <noreply@syncsure.com>';

// ---------- DB connection ----------
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // needed for secure cookies on Render behind proxy
app.use(bodyParser.json({ limit: '256kb' }));

// ---------- Device Management Functions ----------

// Send email notification using Resend
async function sendDeviceNotification(email, subject, htmlContent) {
  if (!resend) {
    console.log(`📧 Email notification skipped (no RESEND_API_KEY): ${subject}`);
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [email],
      subject: subject,
      html: htmlContent
    });

    if (error) {
      console.error('📧 Email send error:', error);
      return false;
    }

    console.log(`📧 Email sent successfully to ${email}: ${subject}`);
    return true;
  } catch (error) {
    console.error('📧 Email send exception:', error);
    return false;
  }
}

// Check for devices that need grace period or cleanup
async function processDeviceManagement() {
  const client = await pool.connect();
  try {
    console.log('🔍 Running device management check...');

    // Find devices offline for 7+ days (grace period start)
    const gracePeriodDevices = await client.query(`
      SELECT lb.*, l.customer_email, l.notification_email, l.email_notifications, l.key as license_key
      FROM license_bindings lb
      JOIN licenses l ON lb.license_id = l.id
      WHERE lb.status = 'active'
        AND lb.last_seen < NOW() - INTERVAL '7 days'
        AND lb.grace_period_start IS NULL
        AND l.status = 'active'
    `);

    // Start grace period for offline devices
    for (const device of gracePeriodDevices.rows) {
      await client.query(`
        UPDATE license_bindings 
        SET grace_period_start = NOW(), status = 'grace_period'
        WHERE id = $1
      `, [device.id]);

      // Log the action
      await client.query(`
        INSERT INTO device_management_log (license_id, device_hash, action, details)
        VALUES ($1, $2, 'grace_period_started', 'Device offline for 7+ days, starting grace period')
      `, [device.license_id, device.device_hash]);

      // Send notification email
      if (device.email_notifications && device.notification_email) {
        const deviceName = device.device_name || device.device_hash;
        const subject = `SyncSure Alert: Device "${deviceName}" Offline`;
        const htmlContent = `
          <h2>Device Offline Alert</h2>
          <p>Your SyncSure device has been offline for 7 days:</p>
          <ul>
            <li><strong>Device:</strong> ${deviceName}</li>
            <li><strong>License:</strong> ${device.license_key}</li>
            <li><strong>Last Seen:</strong> ${new Date(device.last_seen).toLocaleString()}</li>
          </ul>
          <p><strong>Grace Period:</strong> Your device will be automatically removed in 23 days if it doesn't come back online.</p>
          <p>If you've moved this device or no longer need it, you can manually remove it from your dashboard.</p>
          <hr>
          <p><small>SyncSure Device Management</small></p>
        `;
        
        await sendDeviceNotification(device.notification_email, subject, htmlContent);
      }

      console.log(`📱 Started grace period for device: ${device.device_hash}`);
    }

    // Find devices ready for cleanup (30+ days offline)
    const cleanupDevices = await client.query(`
      SELECT lb.*, l.customer_email, l.notification_email, l.email_notifications, l.key as license_key
      FROM license_bindings lb
      JOIN licenses l ON lb.license_id = l.id
      WHERE lb.status IN ('grace_period', 'active')
        AND lb.last_seen < NOW() - INTERVAL '30 days'
        AND l.status = 'active'
    `);

    // Cleanup old devices
    for (const device of cleanupDevices.rows) {
      // Send final notification before cleanup
      if (device.email_notifications && device.notification_email && !device.cleanup_notification_sent) {
        const deviceName = device.device_name || device.device_hash;
        const subject = `SyncSure: Device "${deviceName}" Removed`;
        const htmlContent = `
          <h2>Device Automatically Removed</h2>
          <p>Your SyncSure device has been automatically removed due to being offline for 30+ days:</p>
          <ul>
            <li><strong>Device:</strong> ${deviceName}</li>
            <li><strong>License:</strong> ${device.license_key}</li>
            <li><strong>Last Seen:</strong> ${new Date(device.last_seen).toLocaleString()}</li>
          </ul>
          <p><strong>License Seat Freed:</strong> This device seat is now available for a new device.</p>
          <p>If you need to reinstall SyncSure on this device, simply run the agent again with your license key.</p>
          <hr>
          <p><small>SyncSure Device Management</small></p>
        `;
        
        await sendDeviceNotification(device.notification_email, subject, htmlContent);
        
        // Mark notification as sent
        await client.query(`
          UPDATE license_bindings 
          SET cleanup_notification_sent = true
          WHERE id = $1
        `, [device.id]);
      }

      // Remove the device
      await client.query(`
        UPDATE license_bindings 
        SET status = 'removed'
        WHERE id = $1
      `, [device.id]);

      // Log the action
      await client.query(`
        INSERT INTO device_management_log (license_id, device_hash, action, details)
        VALUES ($1, $2, 'auto_cleanup', 'Device automatically removed after 30 days offline')
      `, [device.license_id, device.device_hash]);

      console.log(`🗑️ Auto-removed device: ${device.device_hash}`);
    }

    // Send weekly summary to admin
    if (gracePeriodDevices.rows.length > 0 || cleanupDevices.rows.length > 0) {
      const subject = `SyncSure Device Management Summary`;
      const htmlContent = `
        <h2>Device Management Summary</h2>
        <p><strong>Grace Period Started:</strong> ${gracePeriodDevices.rows.length} devices</p>
        <p><strong>Devices Cleaned Up:</strong> ${cleanupDevices.rows.length} devices</p>
        <hr>
        <p><small>SyncSure Automated Device Management</small></p>
      `;
      
      await sendDeviceNotification(ADMIN_EMAIL, subject, htmlContent);
    }

    console.log(`✅ Device management complete: ${gracePeriodDevices.rows.length} grace period, ${cleanupDevices.rows.length} cleanup`);

  } catch (error) {
    console.error('❌ Device management error:', error);
  } finally {
    client.release();
  }
}

// ---------- Trigger for updating last_seen ----------
async function updateDeviceLastSeen(client, licenseId, deviceHash) {
  await client.query(`
    UPDATE license_bindings 
    SET last_seen = NOW(), 
        status = CASE 
          WHEN status IN ('grace_period', 'removed') THEN 'active'
          ELSE status 
        END,
        grace_period_start = CASE 
          WHEN status = 'grace_period' THEN NULL
          ELSE grace_period_start 
        END
    WHERE license_id = $1 AND device_hash = $2
  `, [licenseId, deviceHash]);
}

// ---------- Enhanced Schema with Device Management (UUID Compatible) ----------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up enhanced database schema...');
    
    // Create the users table if it doesn't exist - matching existing structure
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        name        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create licenses table with UUID (matching existing structure)
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 5,
        customer_email VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NULL,
        notification_email VARCHAR(255),
        email_notifications BOOLEAN DEFAULT true
      );
    `);

    // Add missing columns to licenses table if they don't exist
    const licenseColumns = [
      { name: 'notification_email', type: 'VARCHAR(255)' },
      { name: 'email_notifications', type: 'BOOLEAN DEFAULT true' }
    ];

    for (const col of licenseColumns) {
      const colExists = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='licenses' AND column_name=$1
      `, [col.name]);
      
      if (colExists.rowCount === 0) {
        console.log(`Adding missing "${col.name}" column to licenses table...`);
        await client.query(`ALTER TABLE licenses ADD COLUMN ${col.name} ${col.type};`);
      }
    }

    // Create enhanced license_bindings table with device management (UUID compatible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_bindings (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        device_name VARCHAR(255),
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        grace_period_start TIMESTAMPTZ NULL,
        offline_notification_sent BOOLEAN DEFAULT false,
        cleanup_notification_sent BOOLEAN DEFAULT false,
        CONSTRAINT unique_license_device UNIQUE (license_id, device_hash)
      );
    `);

    // Add missing columns to license_bindings if they don't exist
    const bindingColumns = [
      { name: 'device_name', type: 'VARCHAR(255)' },
      { name: 'status', type: 'VARCHAR(50) DEFAULT \'active\'' },
      { name: 'grace_period_start', type: 'TIMESTAMPTZ NULL' },
      { name: 'offline_notification_sent', type: 'BOOLEAN DEFAULT false' },
      { name: 'cleanup_notification_sent', type: 'BOOLEAN DEFAULT false' }
    ];

    for (const col of bindingColumns) {
      const colExists = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='license_bindings' AND column_name=$1
      `, [col.name]);
      
      if (colExists.rowCount === 0) {
        console.log(`Adding missing "${col.name}" column to license_bindings table...`);
        await client.query(`ALTER TABLE license_bindings ADD COLUMN ${col.name} ${col.type};`);
      }
    }

    // Create heartbeats table (UUID compatible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        message TEXT,
        error_detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT heartbeats_status_check CHECK (status IN ('ok', 'warn', 'error', 'asleep'))
      );
    `);

    // Create device management log table (UUID compatible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_management_log (
        id BIGSERIAL PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_hash VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create basic indexes first
    await client.query('CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_license_id ON license_bindings(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_device_hash ON license_bindings(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_license_id ON heartbeats(license_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_device_hash ON heartbeats(device_hash);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_heartbeats_created_at ON heartbeats(created_at);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_management_log_license_id ON device_management_log(license_id);');

    // Create indexes for new columns only if they exist
    const lastSeenExists = await client.query(`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='license_bindings' AND column_name='last_seen'
    `);
    if (lastSeenExists.rowCount > 0) {
      await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_last_seen ON license_bindings(last_seen);');
      await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_status ON license_bindings(status);');
    }

    // Insert test data
    await client.query(`
      INSERT INTO licenses (key, status, max_devices, customer_email, notification_email) VALUES
        ('SYNC-TEST-123', 'active', 10, 'test@syncsure.com', 'test@syncsure.com'),
        ('SYNC-DEMO-456', 'active', 5, 'demo@syncsure.com', 'demo@syncsure.com'),
        ('SYNC-PROD-789', 'active', 25, 'customer@syncsure.com', 'customer@syncsure.com')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Create test user account
    const testUserExists = await client.query('SELECT id FROM users WHERE email = $1', ['test@syncsure.com']);
    if (testUserExists.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await client.query(
        'INSERT INTO users (email, password, name) VALUES ($1, $2, $3)',
        ['test@syncsure.com', hashedPassword, 'Test User']
      );
      console.log('✅ Created test user: test@syncsure.com / password123');
    }

    console.log('✅ Enhanced database schema setup complete!');
    
  } catch (err) {
    console.error('❌ Error during schema setup:', err);
  } finally {
    client.release();
  }
}

// Run the schema check on startup
ensureSchema().catch(console.error);

// Schedule device management to run daily at 2 AM
cron.schedule('0 2 * * *', () => {
  console.log('⏰ Running scheduled device management...');
  processDeviceManagement();
});

// Also run device management every 6 hours for more frequent checks
cron.schedule('0 */6 * * *', () => {
  console.log('⏰ Running periodic device management check...');
  processDeviceManagement();
});

// ---------- GLOBAL CORS CONFIGURATION ----------
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://sync-sure-agents5.replit.app';

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow your frontend origin
    if (origin === FRONTEND_ORIGIN) {
      return callback(null, true);
    }
    
    // Allow Replit domains
    if (origin.endsWith('.replit.app') || origin.endsWith('.replit.dev')) {
      return callback(null, true);
    }
    
    // Allow any origin for non-auth routes (heartbeat, etc.)
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'User-Agent', 'Origin', 'Accept'],
  exposedHeaders: ['Set-Cookie']
}));

// Handle preflight requests
app.options('*', cors());

// ---------- Session Configuration ----------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
app.use(session({
  name: 'syncsure.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,      // not available to JS
    secure: process.env.NODE_ENV === 'production', // secure in production
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // cross-site in production
    maxAge: 7 * 24 * 3600 * 1000 // 7 days
  }
}));

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------- Event Catalog + Normalization ----------
const EventCatalog = {
  // Critical Failures → error
  process_missing:    { status: 'error',  eventType: 'sync_error',        description: 'OneDrive process not running' },
  auth_error:         { status: 'error',  eventType: 'sync_error',        description: 'Authentication / login errors' },
  sync_blocked:       { status: 'error',  eventType: 'sync_paused',       description: 'Sync blocked (paused/denied)' },
  connectivity_fail:  { status: 'error',  eventType: 'sync_error',        description: 'Connectivity failure to OneDrive endpoints' },
  file_errors_high:   { status: 'error',  eventType: 'sync_error',        description: 'Large number of file errors' },
  disk_full:          { status: 'error',  eventType: 'sync_error',        description: 'Disk full / quota exceeded' },

  // Warnings → warn
  pending_long:       { status: 'warn',   eventType: 'sync_status_check', description: 'Sync stuck / long pending' },
  partial_errors:     { status: 'warn',   eventType: 'sync_status_check', description: 'A few file sync errors (1–5)' },
  network_hiccup:     { status: 'warn',   eventType: 'sync_status_check', description: 'Temporary network hiccup' },
  heartbeat_unknown:  { status: 'warn',   eventType: 'sync_status_check', description: 'Tool heartbeat seen, but unknown state' },
  auth_warning:       { status: 'warn',   eventType: 'sync_status_check', description: 'Authentication warnings detected' },

  // Healthy → ok
  process_running:    { status: 'ok',     eventType: 'sync_status_check', description: 'OneDrive process is running' },
  healthy:            { status: 'ok',     eventType: 'sync_status_check', description: 'Everything looks good' },

  // Device state → asleep
  device_asleep:      { status: 'asleep', eventType: 'sync_status_check', description: 'Agent reports system sleep' },
  device_shutdown:    { status: 'asleep', eventType: 'sync_status_check', description: 'Agent reports shutdown' },
};

function normalizeEvent(inputStatus, inputEventType) {
  const key = String((inputEventType || '').toLowerCase().trim());
  if (EventCatalog[key]) return EventCatalog[key];

  const aliases = {
    'onedrive_running': 'process_running',
    'onedrive_missing': 'process_missing',
    'auth_failed':      'auth_error',
    'net_fail':         'connectivity_fail',
    'errors_high':      'file_errors_high',
    'errors_some':      'partial_errors',
    'stuck_pending':    'pending_long',
    'asleep':           'device_asleep',
    'shutdown':         'device_shutdown',
  };
  if (aliases[key] && EventCatalog[aliases[key]]) {
    return EventCatalog[aliases[key]];
  }

  // Map based on input status to frontend event types
  const s = String((inputStatus || '').toLowerCase().trim());
  if (s === 'ok') {
    return { status: 'ok', eventType: 'sync_status_check' };
  } else if (s === 'warn') {
    return { status: 'warn', eventType: 'sync_status_check' };
  } else if (s === 'error') {
    return { status: 'error', eventType: 'sync_error' };
  } else if (s === 'asleep') {
    return { status: 'asleep', eventType: 'sync_status_check' };
  }

  return { status: 'warn', eventType: 'sync_status_check' };
}

// ---------- Enhanced heartbeat insert ----------
async function handleHeartbeatInsert(client, {
  licenseKey, deviceHash, rawStatus, rawEventType, message, errorDetail
}) {
  if (!licenseKey || !deviceHash) {
    return { http: 400, body: { error: 'Missing licenseKey/deviceHash' } };
  }

  // license
  const lic = await client.query(
    `select id, status, max_devices from licenses where key=$1 limit 1`,
    [licenseKey]
  );
  if (lic.rows.length === 0) return { http: 401, body: { error: 'License not found' } };
  const L = lic.rows[0];
  if ((L.status || 'active') !== 'active') return { http: 403, body: { error: `License ${L.status}` } };

  // binding + seats (only count active devices)
  const bound = await client.query(
    `select id, status from license_bindings where license_id=$1 and device_hash=$2 limit 1`,
    [L.id, deviceHash]
  );
  
  if (bound.rows.length === 0) {
    const cnt = await client.query(
      `select count(*)::int as c from license_bindings where license_id=$1 and status = 'active'`,
      [L.id]
    );
    if (cnt.rows[0].c >= (L.max_devices || 1)) {
      return { http: 403, body: { error: 'Seat limit reached' } };
    }
    await client.query(
      `insert into license_bindings(license_id, device_hash, device_name, status)
       values($1,$2,$3,'active')
       on conflict (license_id, device_hash) do nothing`,
      [L.id, deviceHash, deviceHash]
    );

    // Log device registration
    await client.query(
      `INSERT INTO device_management_log (license_id, device_hash, action, details)
       VALUES ($1, $2, 'device_registered', 'New device automatically registered')`,
      [L.id, deviceHash]
    );
  } else if (bound.rows[0].status === 'removed') {
    return { http: 403, body: { error: 'Device has been removed. Contact support to reactivate.' } };
  }

  // Update last seen and reactivate if needed
  await updateDeviceLastSeen(client, L.id, deviceHash);

  // normalize + insert
  const normalized = normalizeEvent(rawStatus, rawEventType);
  const finalStatus    = normalized.status;
  const finalEventType = normalized.eventType;

  await client.query(
    `insert into heartbeats(license_id, device_hash, status, event_type, message, error_detail)
     values($1,$2,$3,$4,$5,$6)`,
    [L.id, deviceHash, finalStatus, finalEventType, message || null, errorDetail ?? null]
  );

  return { http: 200, body: { ok: true, normalized: { status: finalStatus, eventType: finalEventType } } };
}

// ---------- Authentication Routes ----------
app.post('/api/auth/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    
    // Check if user already exists
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user with name (use email prefix if no name provided)
    const userName = name || email.split('@')[0];
    const result = await client.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, hashedPassword, userName]
    );
    
    const user = result.rows[0];
    req.session.userId = user.id;
    
    res.json({ user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    
    // Get user
    const result = await client.query('SELECT id, email, password, name, created_at FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    // Verify password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // Set session
    req.session.userId = user.id;
    
    // Return user without password
    const { password: userPassword, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT id, email, name, created_at FROM users WHERE id = $1', [req.session.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: 'Could not log out' });
    }
    res.json({ success: true });
  });
});

// ---------- Enhanced Dashboard Stats Route ----------
app.get('/api/dashboard/stats', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const client = await pool.connect();
  try {
    // Get user's email to find their licenses
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userEmail = userResult.rows[0].email;

    // Get licenses for this user (you may want to adjust this logic)
    const licensesResult = await client.query('SELECT id, max_devices FROM licenses WHERE customer_email = $1 OR $1 = $2', [userEmail, 'test@syncsure.com']);
    
    if (licensesResult.rows.length === 0) {
      return res.json({
        totalDevices: 0,
        activeDevices: 0,
        healthyDevices: 0,
        warningDevices: 0,
        errorDevices: 0,
        asleepDevices: 0,
        gracePeriodDevices: 0,
        seatsUsed: 0,
        seatsTotal: 0,
        lastUpdate: new Date().toISOString()
      });
    }

    const licenseIds = licensesResult.rows.map(l => l.id);
    const seatsTotal = licensesResult.rows.reduce((sum, l) => sum + l.max_devices, 0);

    // Get latest heartbeat status for each device in last 10 minutes
    const heartbeatsResult = await client.query(`
      SELECT DISTINCT ON (device_hash) device_hash, status, created_at
      FROM heartbeats 
      WHERE license_id = ANY($1) AND created_at > NOW() - INTERVAL '10 minutes'
      ORDER BY device_hash, created_at DESC
    `, [licenseIds]);

    // Get device management stats
    const deviceStatsResult = await client.query(`
      SELECT 
        COUNT(*) as total_devices,
        COUNT(*) FILTER (WHERE status = 'active') as active_devices,
        COUNT(*) FILTER (WHERE status = 'grace_period') as grace_period_devices
      FROM license_bindings 
      WHERE license_id = ANY($1) AND status != 'removed'
    `, [licenseIds]);

    const stats = {
      totalDevices: 0,
      activeDevices: 0,
      healthyDevices: 0,
      warningDevices: 0,
      errorDevices: 0,
      asleepDevices: 0,
      gracePeriodDevices: parseInt(deviceStatsResult.rows[0]?.grace_period_devices) || 0,
      seatsUsed: parseInt(deviceStatsResult.rows[0]?.active_devices) || 0,
      seatsTotal,
      lastUpdate: new Date().toISOString()
    };

    heartbeatsResult.rows.forEach(heartbeat => {
      stats.totalDevices++;
      stats.activeDevices++;

      switch (heartbeat.status) {
        case 'ok':
          stats.healthyDevices++;
          break;
        case 'warn':
          stats.warningDevices++;
          break;
        case 'error':
          stats.errorDevices++;
          break;
        case 'asleep':
          stats.asleepDevices++;
          break;
      }
    });

    res.json(stats);
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Enhanced Heartbeats Route ----------
app.get('/api/heartbeats', async (req, res) => {
  const licenseKey = (req.query.licenseKey || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey is required' });

  const client = await pool.connect();
  try {
    const lic = await client.query(
      `SELECT id FROM licenses WHERE key=$1 LIMIT 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(404).json({ error: 'License not found' });
    const licenseId = lic.rows[0].id;

    // Get devices with enhanced status information
    const devicesResult = await client.query(`
      SELECT
        lb.device_hash,
        COALESCE(lb.device_name, lb.device_hash) as device_name,
        lb.last_seen,
        lb.status as device_status,
        lb.grace_period_start,
        (array_agg(h.status ORDER BY h.created_at DESC))[1] as last_status,
        (array_agg(h.event_type ORDER BY h.created_at DESC))[1] as last_event_type,
        (array_agg(h.message ORDER BY h.created_at DESC))[1] as last_message,
        CASE 
          WHEN lb.status = 'removed' THEN 'offline'
          WHEN lb.last_seen < NOW() - INTERVAL '5 minutes' THEN 'offline'
          ELSE COALESCE((array_agg(h.status ORDER BY h.created_at DESC))[1], 'unknown')
        END as display_status
      FROM license_bindings lb
      LEFT JOIN heartbeats h ON lb.license_id = h.license_id AND lb.device_hash = h.device_hash
      WHERE lb.license_id = $1 AND lb.status != 'removed'
      GROUP BY lb.device_hash, lb.device_name, lb.last_seen, lb.status, lb.grace_period_start
      ORDER BY lb.last_seen DESC
    `, [licenseId]);

    res.json({ devices: devicesResult.rows });
  } catch (error) {
    console.error('Heartbeats error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Agent heartbeat route ----------
app.post('/api/heartbeat', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, status, eventType, message, errorDetail } = req.body || {};
    const result = await handleHeartbeatInsert(client, {
      licenseKey, deviceHash, rawStatus: status, rawEventType: eventType, message, errorDetail
    });
    res.status(result.http).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- Offline heartbeat route ----------
app.post('/api/heartbeat/offline', async (req, res) => {
  const client = await pool.connect();
  try {
    const { licenseKey, deviceHash, message, errorDetail, reason } = req.body || {};
    const mappedEvent = String((reason || '').toLowerCase()) === 'sleep' ? 'device_asleep' : 'device_shutdown';
    const result = await handleHeartbeatInsert(client, {
      licenseKey,
      deviceHash,
      rawStatus: 'asleep',
      rawEventType: mappedEvent,
      message: message || (mappedEvent === 'device_asleep' ? 'system sleep' : 'system shutdown'),
      errorDetail
    });
    res.status(result.http).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- Enhanced Device Management API ----------
app.get('/api/devices/:licenseKey', async (req, res) => {
  const { licenseKey } = req.params;
  const client = await pool.connect();
  try {
    const lic = await client.query(
      `SELECT id, max_devices FROM licenses WHERE key=$1 LIMIT 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(404).json({ error: 'License not found' });

    const devices = await client.query(`
      SELECT 
        lb.*,
        EXTRACT(EPOCH FROM (NOW() - lb.last_seen))/3600 as hours_offline,
        CASE 
          WHEN lb.status = 'removed' THEN 'Removed'
          WHEN lb.status = 'grace_period' THEN 'Grace Period'
          WHEN lb.last_seen < NOW() - INTERVAL '5 minutes' THEN 'Offline'
          ELSE 'Online'
        END as connection_status
      FROM license_bindings lb
      WHERE lb.license_id = $1
      ORDER BY lb.last_seen DESC
    `, [lic.rows[0].id]);

    res.json({
      licenseKey,
      maxDevices: lic.rows[0].max_devices,
      devices: devices.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// Manual device removal
app.delete('/api/devices/:licenseKey/:deviceHash', async (req, res) => {
  const { licenseKey, deviceHash } = req.params;
  const client = await pool.connect();
  try {
    const lic = await client.query(
      `SELECT id FROM licenses WHERE key=$1 LIMIT 1`,
      [licenseKey]
    );
    if (lic.rows.length === 0) return res.status(404).json({ error: 'License not found' });

    await client.query(
      `UPDATE license_bindings SET status = 'removed' WHERE license_id = $1 AND device_hash = $2`,
      [lic.rows[0].id, deviceHash]
    );

    await client.query(
      `INSERT INTO device_management_log (license_id, device_hash, action, details)
       VALUES ($1, $2, 'manual_removal', 'Device manually removed via API')`,
      [lic.rows[0].id, deviceHash]
    );

    res.json({ ok: true, message: 'Device removed successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  } finally {
    client.release();
  }
});

// ---------- License routes ----------
app.get('/api/licenses', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const client = await pool.connect();
  try {
    // Get user email
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userEmail = userResult.rows[0].email;

    // Get licenses for this user with device counts
    const licensesResult = await client.query(`
      SELECT l.*, 
        COUNT(lb.device_hash) FILTER (WHERE lb.status = 'active') as active_devices_count,
        COUNT(lb.device_hash) FILTER (WHERE lb.status = 'grace_period') as grace_period_devices_count,
        COUNT(lb.device_hash) as total_devices_count
      FROM licenses l
      LEFT JOIN license_bindings lb ON l.id = lb.license_id AND lb.status != 'removed'
      WHERE l.customer_email = $1 OR $1 = $2
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [userEmail, 'test@syncsure.com']);

    res.json(licensesResult.rows);
  } catch (error) {
    console.error('Licenses error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

// ---------- Manual Device Management Trigger (for testing) ----------
app.post('/api/admin/run-device-management', async (req, res) => {
  try {
    await processDeviceManagement();
    res.json({ ok: true, message: 'Device management completed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// ---------- Database Migration Endpoint ----------
app.post('/api/admin/migrate-database', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('🔧 Running database migration...');
    
    // Add missing columns to license_bindings
    const columns = [
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS device_name VARCHAR(255)',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT \'active\'',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS grace_period_start TIMESTAMPTZ NULL',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS offline_notification_sent BOOLEAN DEFAULT false',
      'ALTER TABLE license_bindings ADD COLUMN IF NOT EXISTS cleanup_notification_sent BOOLEAN DEFAULT false'
    ];
    
    for (const sql of columns) {
      await client.query(sql);
    }
    
    // Update existing records
    await client.query('UPDATE license_bindings SET last_seen = NOW() WHERE last_seen IS NULL');
    await client.query('UPDATE license_bindings SET device_name = device_hash WHERE device_name IS NULL');
    await client.query('UPDATE license_bindings SET status = \'active\' WHERE status IS NULL');
    
    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_last_seen ON license_bindings(last_seen)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_license_bindings_status ON license_bindings(status)');
    
    console.log('✅ Database migration completed');
    res.json({ ok: true, message: 'Database migration completed successfully' });
    
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// ---------- Start server ----------
const PORT = parseInt(process.env.PORT || '5000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SyncSure Backend with Device Management running on port ${PORT}`);
  console.log(`📧 Email notifications: ${resend ? 'Enabled' : 'Disabled (set RESEND_API_KEY)'}`);
  console.log(`⏰ Device management scheduled: Daily at 2 AM and every 6 hours`);
});

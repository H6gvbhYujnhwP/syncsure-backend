-- Add logging tables for comprehensive error handling and monitoring
-- SyncSure V9 Implementation

-- System logs table for persistent logging
CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for efficient log queries
CREATE INDEX IF NOT EXISTS idx_system_logs_type_created ON system_logs(type, created_at);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at);

-- Heartbeat statistics table for monitoring
CREATE TABLE IF NOT EXISTS heartbeat_stats (
    id SERIAL PRIMARY KEY,
    license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    successful_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(license_id, device_id, date)
);

-- Create indexes for heartbeat stats
CREATE INDEX IF NOT EXISTS idx_heartbeat_stats_license_date ON heartbeat_stats(license_id, date);
CREATE INDEX IF NOT EXISTS idx_heartbeat_stats_device_date ON heartbeat_stats(device_id, date);

-- Sessions table for authentication (if not exists)
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    user_agent TEXT,
    ip_address INET,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_accessed TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to heartbeat_stats
DROP TRIGGER IF EXISTS update_heartbeat_stats_updated_at ON heartbeat_stats;
CREATE TRIGGER update_heartbeat_stats_updated_at
    BEFORE UPDATE ON heartbeat_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to sessions
DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add performance monitoring view
CREATE OR REPLACE VIEW heartbeat_health_summary AS
SELECT 
    l.license_key,
    l.pricing_tier,
    hs.device_id,
    db.device_name,
    SUM(hs.successful_count) as total_successful,
    SUM(hs.failed_count) as total_failed,
    ROUND(
        (SUM(hs.successful_count)::DECIMAL / NULLIF(SUM(hs.successful_count) + SUM(hs.failed_count), 0)) * 100, 
        2
    ) as success_rate,
    MAX(hs.date) as last_heartbeat_date,
    db.last_heartbeat as last_heartbeat_timestamp
FROM heartbeat_stats hs
JOIN licenses l ON hs.license_id = l.id
LEFT JOIN device_bindings db ON hs.license_id = db.license_id AND hs.device_id = db.device_id
WHERE hs.date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY l.license_key, l.pricing_tier, hs.device_id, db.device_name, db.last_heartbeat
ORDER BY l.license_key, hs.device_id;

-- Add system health monitoring view
CREATE OR REPLACE VIEW system_health_summary AS
SELECT 
    DATE(created_at) as log_date,
    type as log_type,
    COUNT(*) as log_count,
    COUNT(CASE WHEN data->>'success' = 'false' THEN 1 END) as error_count,
    ROUND(
        (COUNT(CASE WHEN data->>'success' = 'true' THEN 1 END)::DECIMAL / COUNT(*)) * 100,
        2
    ) as success_rate
FROM system_logs
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(created_at), type
ORDER BY log_date DESC, log_type;

-- Add cleanup function for old logs
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete system logs older than 30 days
    DELETE FROM system_logs 
    WHERE created_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Delete heartbeat stats older than 90 days
    DELETE FROM heartbeat_stats 
    WHERE date < CURRENT_DATE - INTERVAL '90 days';
    
    -- Delete expired sessions
    DELETE FROM sessions 
    WHERE expires_at < NOW() OR status = 'expired';
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON system_logs TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON heartbeat_stats TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO postgres;
GRANT USAGE ON SEQUENCE system_logs_id_seq TO postgres;
GRANT USAGE ON SEQUENCE heartbeat_stats_id_seq TO postgres;

-- Add comments for documentation
COMMENT ON TABLE system_logs IS 'Persistent storage for system operation logs and errors';
COMMENT ON TABLE heartbeat_stats IS 'Daily aggregated statistics for device heartbeat monitoring';
COMMENT ON TABLE sessions IS 'User authentication sessions for dashboard access';
COMMENT ON VIEW heartbeat_health_summary IS 'Summary view of device heartbeat health over the last 30 days';
COMMENT ON VIEW system_health_summary IS 'Summary view of system operation health over the last 7 days';
COMMENT ON FUNCTION cleanup_old_logs() IS 'Maintenance function to clean up old log entries';

-- Insert initial test data for verification
INSERT INTO system_logs (type, data) VALUES 
('system_startup', '{"message": "Logging system initialized", "version": "v9", "timestamp": "' || NOW() || '"}')
ON CONFLICT DO NOTHING;


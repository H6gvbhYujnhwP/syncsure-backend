-- SyncSure Database Schema
-- This schema includes the account_id column in builds table (FIXED)

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  stripe_customer_id text UNIQUE,
  role text NOT NULL DEFAULT 'user',
  created_at timestamptz DEFAULT now()
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  blocks integer NOT NULL CHECK (blocks > 0),
  status text NOT NULL,
  current_period_end timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  license_key text NOT NULL UNIQUE,
  max_devices integer NOT NULL,
  bound_count integer NOT NULL DEFAULT 0,
  last_sync timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Builds table (WITH account_id column - THIS WAS THE FIX!)
CREATE TABLE IF NOT EXISTS builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status text NOT NULL,
  tag text,
  release_url text,
  asset_name text,
  asset_api_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  account_id uuid,
  license_id uuid,
  event text NOT NULL,
  context jsonb,
  created_at timestamptz DEFAULT now()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS subscriptions_account_id_idx ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS licenses_account_id_idx ON licenses(account_id);
CREATE INDEX IF NOT EXISTS builds_license_id_idx ON builds(license_id);
CREATE INDEX IF NOT EXISTS builds_account_id_idx ON builds(account_id);
CREATE INDEX IF NOT EXISTS builds_tag_idx ON builds(tag);
CREATE INDEX IF NOT EXISTS audit_event_idx ON audit_log(event);
CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_log(created_at);

-- Update timestamp function (PROPERLY FORMATTED)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $func$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END
$func$ LANGUAGE plpgsql;

-- Update triggers
DROP TRIGGER IF EXISTS trg_licenses_updated_at ON licenses;
CREATE TRIGGER trg_licenses_updated_at
BEFORE UPDATE ON licenses
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_builds_updated_at ON builds;
CREATE TRIGGER trg_builds_updated_at
BEFORE UPDATE ON builds
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

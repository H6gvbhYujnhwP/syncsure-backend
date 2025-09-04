create extension if not exists "pgcrypto";

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  stripe_customer_id text unique,
  role text not null default 'user',
  created_at timestamptz default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  stripe_subscription_id text unique,
  blocks integer not null check (blocks > 0),
  status text not null,
  current_period_end timestamptz,
  created_at timestamptz default now()
);
create index if not exists subscriptions_account_id_idx on subscriptions(account_id);

create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  license_key text not null unique,
  max_devices integer not null,
  bound_count integer not null default 0,
  last_sync timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists licenses_account_id_idx on licenses(account_id);

create table if not exists builds (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references licenses(id) on delete cascade,
  status text not null,           -- queued | building | released | failed
  tag text,
  release_url text,
  asset_name text,
  asset_api_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists builds_license_id_idx on builds(license_id);
create index if not exists builds_tag_idx on builds(tag);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,            -- stripe|system|admin|user
  account_id uuid,
  license_id uuid,
  event text not null,            -- LICENSE_UPSERT, BUILD_TRIGGERED, WEBHOOK_DELIVERED, etc.
  context jsonb,
  created_at timestamptz default now()
);
create index if not exists audit_event_idx on audit_log(event);
create index if not exists audit_created_at_idx on audit_log(created_at);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_licenses_updated_at on licenses;
create trigger trg_licenses_updated_at
before update on licenses
for each row execute function set_updated_at();

drop trigger if exists trg_builds_updated_at on builds;
create trigger trg_builds_updated_at
before update on builds
for each row execute function set_updated_at();


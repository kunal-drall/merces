-- E14 Meteora support (Solana only)
create table if not exists curve_configs (
  series_id text primary key,
  config_key text not null,
  pool text,
  params jsonb not null,
  generated_by text not null,
  quote_mint text not null,
  token_badge_required boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists curve_monitor (
  id bigserial primary key,
  series_id text not null,
  checked_at timestamptz not null default now(),
  raised numeric(38,0) not null,
  graduated boolean not null,
  pool_progress_bps int
);
create index if not exists curve_monitor_series on curve_monitor (series_id, checked_at desc);

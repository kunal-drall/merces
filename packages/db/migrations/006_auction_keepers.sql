-- E6 auction service, E7 keepers, E8 rate keeper.

-- client-encrypted reveal backups: the server stores ciphertext it cannot read, so a bidder who loses a device can still reveal
create table if not exists bid_backups (
  series_id text not null,
  bidder text not null,
  account_id text not null,
  ciphertext text not null,
  key_hint text,                          -- client-chosen hint (e.g. which wallet/passphrase), never key material
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (series_id, bidder)
);

create table if not exists reminders_sent (
  kind text not null,                     -- reveal | report-due | grace-end | payout-available
  target text not null,                   -- seriesId[:periodId]
  recipient text not null,                -- account id or wallet
  sent_at timestamptz not null default now(),
  primary key (kind, target, recipient)
);

create table if not exists keeper_runs (
  id bigserial primary key,
  job text not null,
  chain text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  actions int not null default 0,
  detail text
);
create index if not exists keeper_runs_job on keeper_runs (job, started_at desc);

create table if not exists rate_pairs (
  chain text not null,
  pair text not null,                     -- "EUR/USD"
  pyth_feed_id text,                      -- 0x… 32-byte id; null until resolved at runtime
  chainlink_feed text,                    -- aggregator address when a cross-check exists on the chain
  enabled boolean not null default true,
  last_snapshot_day int,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (chain, pair)
);

create table if not exists fx_cross_checks (
  chain text not null,
  pair text not null,
  day_index int not null,
  pyth_rate_wad numeric(38,0) not null,
  chainlink_rate_wad numeric(38,0),
  deviation_bps int,
  within_band boolean,
  primary key (chain, pair, day_index)
);

-- fallback requests routed to attestors (E10 consumes them)
create table if not exists fx_fallback_requests (
  request_id text primary key,
  chain text not null,
  pair text not null,
  period_id text not null,
  reason text not null,
  state text not null default 'open' check (state in ('open','signed','rejected')),
  attestor text,
  rate_wad numeric(38,0),
  signature text,
  created_at timestamptz not null default now(),
  signed_at timestamptz
);
create unique index if not exists fx_fallback_unique on fx_fallback_requests (chain, pair, period_id);

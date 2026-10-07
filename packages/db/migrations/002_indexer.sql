-- Read model fed by the indexer. One schema for both chains; every row carries the chain key.
-- Money columns are numeric(38,0): base units, exact.

create table if not exists indexer_cursors (
  chain text primary key,
  cursor text,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists events (
  chain text not null,
  cursor text not null,
  seq bigint not null,
  block_time bigint not null,
  block_ref text not null,
  tx_id text not null,
  type text not null,
  series_id text,
  payload jsonb not null,
  indexed_at timestamptz not null default now(),
  primary key (chain, cursor)
);
create index if not exists events_series on events (series_id, seq);
create index if not exists events_type on events (chain, type, seq);

-- confirmed-but-not-finalised events: interface hints only, never projected into money tables
create table if not exists events_pending (
  chain text not null,
  cursor text not null,
  seq bigint not null,
  type text not null,
  series_id text,
  payload jsonb not null,
  seen_at timestamptz not null default now(),
  primary key (chain, cursor)
);

create table if not exists issuers (
  chain text not null,
  issuer text not null,
  registered_at bigint not null,
  issuance_stopped boolean not null default false,
  primary key (chain, issuer)
);

create table if not exists series (
  series_id text primary key,
  chain text not null,
  issuer text not null,
  stablecoin text not null,
  stablecoin_mint text not null,
  raise_style text not null,
  units_offered numeric(38,0) not null,
  reserve_price numeric(38,0) not null,
  minimum_raise numeric(38,0) not null,
  cap_multiple_wad numeric(38,0) not null,
  lockup_seconds bigint not null,
  release_schedule jsonb not null,
  auction_fee_bps int not null,
  payout_fee_bps int not null,
  hurdle_wad numeric(38,0) not null,
  payout_multiple_k int not null,
  wallet_cap_bps int not null,
  due_days int not null,
  grace_days int not null,
  formal_notice_days int not null,
  contract_hash text not null,
  terms_commitment text not null,
  tier_flags jsonb not null,
  reporting_currency text not null,
  phase text not null default 'Draft',
  status text not null default 'OnTime',
  created_at bigint not null,
  opened_at bigint,
  commit_ends_at bigint,
  reveal_ends_at bigint,
  settled_at bigint,
  issue_price numeric(38,0),
  units_sold numeric(38,0) not null default 0,
  units_outstanding numeric(38,0) not null default 0,
  cap_per_unit numeric(38,0),
  paid_per_unit_wad numeric(38,0) not null default 0,
  gross_paid_total numeric(38,0) not null default 0,
  fees_total numeric(38,0) not null default 0,
  treasury_total numeric(38,0) not null default 0,
  treasury_released numeric(38,0) not null default 0,
  releases_paused boolean not null default false,
  lockup_ends_at bigint,
  redeemed_at bigint,
  redemption_price numeric(38,0),
  extinguished_at bigint,
  last_event_seq bigint not null default 0
);
create index if not exists series_issuer on series (chain, issuer);
create index if not exists series_status on series (status);

create table if not exists bids (
  series_id text not null,
  bidder text not null,
  commitment text not null,
  deposit numeric(38,0) not null,
  bid_order int not null,
  revealed_price numeric(38,0),
  revealed_quantity numeric(38,0),
  allocated_units numeric(38,0) not null default 0,
  refunded numeric(38,0) not null default 0,
  primary key (series_id, bidder)
);

create table if not exists positions (
  series_id text not null,
  wallet text not null,
  units numeric(38,0) not null default 0,
  claimed_total numeric(38,0) not null default 0,
  redeemed_units numeric(38,0) not null default 0,
  burned_units numeric(38,0) not null default 0,
  first_seq bigint not null,
  last_seq bigint not null,
  primary key (series_id, wallet)
);
create index if not exists positions_wallet on positions (wallet);

create table if not exists periods (
  series_id text not null,
  period_id text not null,
  tier int,
  payment_due numeric(38,0) not null default 0,
  accrual numeric(38,0) not null default 0,
  paid numeric(38,0) not null default 0,
  split_received numeric(38,0) not null default 0,
  report_accepted boolean not null default false,
  settled boolean not null default false,
  income_commitment text,
  fx_basis text,
  fx_avg_wad numeric(38,0),
  liquidity_event boolean not null default false,
  formal_notice_seq bigint,
  accepted_seq bigint,
  primary key (series_id, period_id)
);

-- every money movement, traceable to a period (R: auditability)
create table if not exists money_events (
  chain text not null,
  seq bigint not null,
  series_id text not null,
  period_id text,
  kind text not null,          -- payment | fee | payout | refund | release | treasury | redemption | tail | burn
  wallet text,
  amount numeric(38,0) not null,
  detail jsonb not null default '{}'::jsonb,
  block_time bigint not null,
  tx_id text not null,
  primary key (chain, seq)
);
create index if not exists money_series on money_events (series_id, seq);
create index if not exists money_wallet on money_events (wallet, seq);

create table if not exists fees_ledger (
  chain text not null,
  seq bigint not null,
  series_id text not null,
  kind text not null,          -- auction | payout
  payer text not null,
  amount numeric(38,0) not null,
  block_time bigint not null,
  tx_id text not null,
  primary key (chain, seq)
);

create table if not exists status_history (
  chain text not null,
  seq bigint not null,
  series_id text not null,
  from_status text not null,
  to_status text not null,
  block_time bigint not null,
  primary key (chain, seq)
);

create table if not exists rate_snapshots (
  chain text not null,
  pair text not null,
  day_index int not null,
  rate_wad numeric(38,0) not null,
  conf_wad numeric(38,0) not null,
  publish_time bigint not null,
  sum_wad numeric(38,0) not null,
  count int not null,
  primary key (chain, pair, day_index)
);
create table if not exists fx_fallbacks (
  chain text not null,
  pair text not null,
  period_id text not null,
  reason text not null,
  primary key (chain, pair, period_id)
);

create table if not exists allowlist (
  chain text not null,
  wallet text not null,
  allowed boolean not null,
  updated_seq bigint not null,
  primary key (chain, wallet)
);
create table if not exists attestors (
  chain text not null,
  attestor text not null,
  active boolean not null,
  primary key (chain, attestor)
);
create table if not exists transfer_windows (
  series_id text not null,
  window_id int not null,
  commit_ends_at bigint not null,
  reveal_ends_at bigint not null,
  cleared boolean not null default false,
  clearing_price numeric(38,0),
  units_transferred numeric(38,0),
  primary key (series_id, window_id)
);
create table if not exists curves (
  series_id text primary key,
  quote_stablecoin text not null,
  graduation_threshold numeric(38,0) not null,
  raised numeric(38,0) not null default 0,
  graduated boolean not null default false
);

-- the public activity feed: no amounts ever (R28)
create table if not exists activity (
  chain text not null,
  seq bigint not null,
  series_id text,
  kind text not null,
  summary text not null,
  block_time bigint not null,
  primary key (chain, seq)
);
create index if not exists activity_series on activity (series_id, seq desc);
create index if not exists activity_time on activity (block_time desc);

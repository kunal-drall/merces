-- E5 ProofOfIncome. Stores only commitments, payment amounts, statuses and provider references. Never a figure.

create table if not exists income_sources (
  source_id text primary key,
  account_id text not null,
  series_id text,
  kind text not null check (kind in ('stripe','deel','distrokid','split','attestor')),
  provider text not null,                -- reclaim | tlsnotary | mock | onchain | attestor
  provider_ref text,                     -- provider id / router address; never credentials
  status text not null default 'connected' check (status in ('connected','disconnected')),
  connected_at timestamptz not null default now()
);
create index if not exists income_sources_series on income_sources (series_id);

create table if not exists reports (
  report_id text primary key,
  series_id text not null,
  period_id text not null,
  account_id text not null,
  tier int not null,
  source text not null,
  state text not null default 'assembled' check (state in ('assembled','submitted','accepted','paid','rejected','superseded')),
  payment_stable numeric(38,0) not null,
  income_commitment text not null,
  terms_commitment text not null,
  fx_basis text not null,
  fx_avg_wad numeric(38,0) not null,
  pair text,
  proof jsonb not null,                  -- public inputs + proof bytes (no witness)
  attestation jsonb,                     -- verifier attestation (commitment + signature)
  attestor_rate jsonb,
  liquidity_event boolean not null default false,
  verified_offchain boolean not null default false,
  submit_tx text,
  payin_tx text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reports_series_period on reports (series_id, period_id);

create table if not exists zktls_sessions (
  session_id text primary key,
  series_id text not null,
  period_id text not null,
  account_id text not null,
  source text not null,
  provider text not null,
  request_url text not null,
  created_at timestamptz not null default now()
);

-- tier 4 scaffolding (switched off): random audit sampling of self-attested reports
create table if not exists audit_samples (
  sample_id text primary key,
  report_id text not null,
  sampled_at timestamptz not null default now(),
  sampled_by text not null,
  outcome text not null default 'pending' check (outcome in ('pending','passed','failed'))
);

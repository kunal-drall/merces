-- Only public service commands and end-to-end encrypted verifier envelopes are queued.
create table local_operator_jobs (
  id uuid primary key,
  owner text,
  kind text not null check (kind in ('service','verifier')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','leased','complete','failed')),
  lease uuid,
  leased_until timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz
);
create index local_operator_pending on local_operator_jobs(status, created_at);
create table local_operator_heartbeat (
  singleton boolean primary key default true check (singleton),
  seen_at timestamptz not null,
  verifier jsonb not null
);

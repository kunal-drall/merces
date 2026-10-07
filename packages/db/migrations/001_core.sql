-- Core infrastructure: idempotency keys, outbox, job queue, append-only audit log.

create table if not exists idempotency_keys (
  key text primary key,
  scope text not null,
  request_hash text not null,
  status_code int not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists outbox (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index if not exists outbox_pending on outbox (id) where dispatched_at is null;

create table if not exists jobs (
  id bigserial primary key,
  kind text not null,
  dedupe_key text,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  locked_until timestamptz,
  attempts int not null default 0,
  max_attempts int not null default 10,
  done_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index if not exists jobs_dedupe on jobs (kind, dedupe_key) where done_at is null and dedupe_key is not null;
create index if not exists jobs_ready on jobs (run_at) where done_at is null;

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  actor_role text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb
);
create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update before update or delete on audit_log for each row execute function audit_log_immutable();

create table if not exists feature_flags (
  name text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into feature_flags (name, enabled) values ('tier4', false), ('transfer_windows', false), ('early_draws', false), ('secondary_trading', false), ('private_payouts', false)
  on conflict (name) do nothing;

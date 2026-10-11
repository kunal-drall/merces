-- Separate from account identity, income and mechanism data. No public reads.
create table public_form_entries (
  id uuid primary key,
  form text not null,
  submission_key text not null,
  request_hash text not null,
  email_hash text not null,
  ciphertext text not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique(form, submission_key)
);
create index public_form_email_time on public_form_entries(email_hash, received_at);
create table public_form_mail (
  entry_id uuid primary key references public_form_entries(id) on delete cascade,
  ciphertext text not null,
  status text not null default 'pending' check(status in ('pending','sent','delivered','bounced','complained','suppressed','failed','uncertain')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  provider_id text unique,
  last_error text
);
create table public_form_suppressions (
  email_hash text primary key,
  reason text not null check(reason in ('bounced','complained','requested')),
  created_at timestamptz not null default now()
);
create table public_form_webhooks (event_id text primary key, received_at timestamptz not null default now());
create table public_form_delivery_events (
  provider_id text primary key,
  state text not null check(state in ('delivered','bounced','complained')),
  received_at timestamptz not null default now()
);

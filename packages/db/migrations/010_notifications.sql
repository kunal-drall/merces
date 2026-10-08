-- E12 notifications: per-account inbox (statuses, never reasons), per-account preferences, and the mock email
-- channel's outbox (Part J.6: email first). Nothing here holds income, documents, hardship reasons or amounts.

-- one inbox row per (outbox payload, recipient): redelivery of an outbox row never double-notifies
create table if not exists notifications (
  notification_id text primary key,
  account_id text not null references accounts(account_id),
  kind text not null,                                 -- the outbox payload kind, e.g. reporting.report-due
  subject text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,            -- whitelisted keys only: statuses, dates, series/period ids; never reasons or amounts
  payload_hash text not null,                         -- sha256 of the canonical outbox payload
  email_sent_at timestamptz,                          -- set once the channel accepted the email (retried if the first send failed)
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists notifications_dedupe on notifications (payload_hash, account_id);
create index if not exists notifications_inbox on notifications (account_id, created_at desc);
create index if not exists notifications_unread on notifications (account_id) where read_at is null;

-- absent row = defaults (email on, nothing muted)
create table if not exists notification_preferences (
  account_id text primary key references accounts(account_id),
  email boolean not null default true,
  muted_kinds text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- the mock email channel: every row is exactly what a real provider would have been handed (dev visibility, admin-only)
create table if not exists email_outbox (
  email_id text primary key,
  to_address text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists email_outbox_time on email_outbox (created_at desc);

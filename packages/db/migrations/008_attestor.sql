-- E10 attestor service: hardship pauses (private attestor review), tier-3 cases and annual true-ups,
-- two-attestor extinguishment requests. Hardship and tier-3 rows hold END-TO-END ciphertext produced on the
-- client for the chosen attestor's key: the server stores it opaque and never decrypts it. Never a reason, a
-- figure or a document. Decision fields are codes. Money columns are numeric(38,0) base units.

create table if not exists hardship_requests (
  hardship_id text primary key,
  series_id text not null,
  chain text not null,
  issuer text not null,
  account_id text not null,
  attestor text not null,                   -- the registered attestor the issuer chose (the only reader of the ciphertext)
  requested_until bigint not null,          -- unix seconds
  approved_until bigint,
  ciphertext text not null,                 -- E2E ciphertext for the attestor; opaque to the server
  key_hint text,                            -- client-chosen hint (which attestor key), never key material
  state text not null default 'pending' check (state in ('pending','approved','rejected')),
  decision_code text,                       -- 'approved' | a rejection code; never free text
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists hardship_requests_series on hardship_requests (series_id, created_at desc);
create index if not exists hardship_requests_pending on hardship_requests (attestor) where state = 'pending';

create table if not exists tier3_cases (
  case_id text primary key,
  series_id text not null,
  chain text not null,
  period_id text not null,
  issuer text not null,
  account_id text not null,
  attestor text not null,
  documents_ciphertext text not null,       -- E2E ciphertext of tax returns / accounting exports for the attestor; opaque
  key_hint text,
  estimate_payment_stable numeric(38,0) not null,   -- the issuer's own quarterly estimate (an amount, never income)
  attested_payment_stable numeric(38,0),            -- the attestor's attested payment for the quarter
  income_commitment text,
  liquidity_event boolean not null default false,
  state text not null default 'open' check (state in ('open','signed','withdrawn')),
  created_at timestamptz not null default now(),
  signed_at timestamptz
);
create index if not exists tier3_cases_series on tier3_cases (series_id, period_id);
create index if not exists tier3_cases_open on tier3_cases (attestor) where state = 'open';

create table if not exists tier3_annual (
  annual_id text primary key,
  series_id text not null,
  chain text not null,
  year int not null,
  issuer text not null,
  account_id text not null,
  attestor text not null,
  documents_ciphertext text not null,       -- E2E ciphertext of the annual documents for the attestor; opaque
  key_hint text,
  state text not null default 'open' check (state in ('open','signed')),
  total_payment_stable numeric(38,0),       -- attested payment owed for the year (amount)
  estimated_payment_stable numeric(38,0),   -- sum of the year's accepted quarterly payments (amount)
  overpayment numeric(38,0),                -- credited to the next period
  underpayment numeric(38,0),               -- due within 60 days, no accrual (A-C8-3)
  trueup_due_at bigint,                     -- unix seconds
  credit_period_id text,
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  unique (series_id, year)
);

create table if not exists extinguishment_requests (
  request_id text primary key,
  series_id text not null,
  chain text not null,
  attestors text[] not null,                -- exactly two distinct registered attestors; both sign the transaction
  requested_by text not null,               -- account id of the attestor who opened the request
  evidence_ciphertext text not null,        -- E2E ciphertext of the death / permanent-disability evidence; opaque
  key_hint text,
  state text not null default 'built' check (state in ('built','sent')),
  created_at timestamptz not null default now()
);
create index if not exists extinguishment_requests_series on extinguishment_requests (series_id);

-- the attestor's rate source for a signed FX fallback, as a code (e.g. 'ecb-reference-rate')
alter table fx_fallback_requests add column if not exists source_note text;

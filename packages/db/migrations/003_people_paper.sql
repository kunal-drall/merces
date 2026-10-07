-- E2 identity, sign-in, onboarding, eligibility. E3 contract signing. E4 terms vault.

create table if not exists accounts (
  account_id text primary key,
  created_at timestamptz not null default now(),
  roles text[] not null default '{}',
  display_name text,
  email text,                      -- optional notification address; never shown to other users
  country text
);

create table if not exists account_wallets (
  chain text not null,
  address text not null,
  account_id text not null references accounts(account_id),
  family text not null,
  linked_at timestamptz not null default now(),
  primary key (chain, address)
);
create index if not exists account_wallets_account on account_wallets (account_id);

create table if not exists auth_nonces (
  nonce text primary key,
  chain text not null,
  address text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- applications: issuer or backer; review states; the identity check reference (never the identity documents)
create table if not exists applications (
  application_id text primary key,
  account_id text not null references accounts(account_id),
  kind text not null check (kind in ('issuer','backer')),
  state text not null default 'draft' check (state in ('draft','submitted','in_review','approved','rejected','withdrawn')),
  chain text,
  wallet text,
  stablecoin text,
  persona text,
  country text,
  income_source_kinds text[] not null default '{}',   -- stripe | deel | distrokid | split | attestor (kinds only, never figures)
  notes_encrypted text,                               -- applicant notes, encrypted with the vault key; admin-only
  identity_check_id text,
  identity_status text not null default 'not_started' check (identity_status in ('not_started','pending','passed','failed')),
  reviewer text,
  decision_reason_code text,                          -- a code, never free text about the person
  readiness jsonb,                                    -- R27 private readiness report (applicant + admin only)
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists applications_account on applications (account_id);
create index if not exists applications_state on applications (state);

create table if not exists eligibility (
  chain text not null,
  wallet text not null,
  account_id text not null,
  kind text not null,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  allowlist_synced_at timestamptz,
  allowlist_tx text,
  primary key (chain, wallet)
);

-- E3: contract templates supplied by counsel, signing sessions, signed documents
create table if not exists contract_templates (
  template_id text primary key,
  kind text not null check (kind in ('heu','charter')),
  version text not null,
  body text not null,                                 -- template text with {{placeholders}}
  body_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists contract_sessions (
  session_id text primary key,
  account_id text not null,
  chain text not null,
  issuer text not null,
  draft_id text not null,                             -- the series draft the contract is for
  provider text not null,
  provider_ref text,
  state text not null default 'prepared' check (state in ('prepared','sent','signed','declined','expired')),
  heu_template_id text not null,
  charter_template_id text not null,
  rendered_hash text not null,                        -- sha256 of the rendered (unsigned) bundle
  signed_hash text,                                   -- sha256 of the signed bundle: anchored in createSeries
  signed_document_encrypted text,                     -- ciphertext only
  signed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists contract_sessions_draft on contract_sessions (draft_id);

-- E4: series drafts hold the public terms; the private terms live encrypted in the vault
create table if not exists series_drafts (
  draft_id text primary key,
  account_id text not null,
  chain text not null,
  issuer text not null,
  public_terms jsonb not null,
  terms_commitment text,
  contract_hash text,
  series_id text,                                     -- set once createSeries lands
  state text not null default 'draft' check (state in ('draft','terms_set','contract_signed','created','abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists terms_vault (
  draft_id text primary key references series_drafts(draft_id),
  series_id text,
  ciphertext text not null,                           -- AES-256-GCM of {threshold, ratePerUnitWad, reportingCurrency, indexingRule, salt}
  key_id text not null,
  commitment text not null,
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists terms_vault_series on terms_vault (series_id);

create table if not exists terms_access_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  draft_id text not null,
  series_id text,
  account_id text not null,
  purpose text not null,
  version int not null
);

create table if not exists terms_amendments (
  amendment_id text primary key,
  series_id text not null,
  draft_id text not null,
  kind text not null,                                 -- inflation-index | cap-decrease
  new_commitment text not null,
  new_cap_multiple_wad numeric(38,0) not null,
  ciphertext text not null,                           -- the new private terms, encrypted
  version int not null,
  state text not null default 'proposed' check (state in ('proposed','attested','submitted','applied','rejected')),
  attestor text,
  attestor_signature text,
  rationale_code text not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

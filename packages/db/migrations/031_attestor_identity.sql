-- S4 owner decision (A-SIG-7): "Extinguishment: two separately verified accounts, enforced at registration."
--
-- An attestor identity check belongs to the account (an issuer's or a backer's belongs to an application, 003): the
-- account starts it (POST /me/attestor/identity-check) and the admin's registerAttestor / rotateAttestor proposal of a
-- key linked to the account is refused (409 identity-not-verified) until it has passed. Together with one attestor key
-- per account and chain (active or proposed; 409 account-already-attestor, admin service) this makes the two keys of an
-- extinguishment two separately verified accounts at registration; the extinguish-time same-account check (S4 D15) stays
-- as defence in depth.
--
-- Only the provider's check id and its status are stored, as for applications: never identity documents or extracted
-- data (PRIVACY.md). One row per account; a failed check is started again in place. A people record (like
-- account_signer_keys): visible to the account and to admins (the status only), never public; kept by a simulator reset.
create table if not exists attestor_identity_checks (
  account_id text primary key references accounts(account_id),
  provider text not null,
  check_id text not null,
  status text not null default 'pending' check (status in ('pending', 'passed', 'failed')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table attestor_identity_checks is 'the account''s attestor identity check: the provider''s check id and status only (A-SIG-7); registration of a key linked to the account needs status passed';

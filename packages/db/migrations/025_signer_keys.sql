-- S4 WP7: attestors are keys (S4 D4; A-M5-2 revised). An attestor's identity is a secp256k1 key's 20-byte address on
-- every chain (0x + 40 lowercase hex), linked to an account by an EIP-191 proof of control made with the key itself
-- (POST /me/signer-keys), never by a chain wallet. Access is per key and per chain, read live on every request: a key
-- linked to the account that is active and indexed in `attestors` on the item's chain.
--
-- The links are people records (like account_wallets): visible to the account and to admins only, never public, and
-- kept by a simulator reset (they name no chain). A key is linked to one account at most.
create table if not exists account_signer_keys (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  account_id text not null references accounts(account_id),
  linked_at timestamptz not null default now()
);
create index if not exists account_signer_keys_account on account_signer_keys (account_id);

-- A link challenge is chain-neutral (amendment fix 2): `chain` becomes nullable, and every nonce names its purpose.
-- Sign-in (`/auth/verify`, `/me/wallets/link`) accepts only a 'sign-in' nonce; the key link (`/me/signer-keys`) only a
-- 'link-signer-key' nonce issued to the same account for the same key. Existing rows are sign-in nonces.
alter table auth_nonces alter column chain drop not null;
alter table auth_nonces add column if not exists purpose text not null default 'sign-in';
alter table auth_nonces add column if not exists account_id text;
alter table auth_nonces drop constraint if exists auth_nonces_purpose_check;
alter table auth_nonces add constraint auth_nonces_purpose_check check (
  (purpose = 'sign-in' and chain is not null)
  or (purpose = 'link-signer-key' and chain is null and account_id is not null)
);

-- The indexed registry holds 20-byte keys only. Rows of a wallet address of another form (the base58 attestors before
-- S4) name no key any chain can register now; they are removed (the raw `events` table keeps their history, and a
-- simulator reset re-indexes every simulator chain anyway).
delete from attestors where attestor !~ '^0x[0-9a-f]{40}$';
alter table attestors drop constraint if exists attestors_attestor_check;
alter table attestors add constraint attestors_attestor_check check (attestor ~ '^0x[0-9a-f]{40}$');

-- Multisig requests for an attestor that is not a 20-byte key (registerAttestor / revokeAttestor{attestor},
-- rotateAttestor{from, to}) cannot be carried by any chain and no longer parse as today's AdminCommand (its attestor
-- fields are keys): they are removed, as 024 removed the ed25519 verifier-key requests. Every one was built for a
-- simulator chain (the live adapters built nothing before S5). The audit log keeps their proposal, append-only.
delete from admin_tx_requests
 where (kind in ('registerAttestor', 'revokeAttestor') and coalesce(command->>'attestor', '') !~ '^0x[0-9a-f]{40}$')
    or (kind = 'rotateAttestor' and (coalesce(command->>'from', '') !~ '^0x[0-9a-f]{40}$' or coalesce(command->>'to', '') !~ '^0x[0-9a-f]{40}$'));

-- A proposal names a key (linked to the proposed account when it is proposed), not a wallet. Proposals of a wallet of
-- another form cannot name a key and are removed (the audit log keeps them, append-only).
delete from attestor_proposals where wallet !~ '^0x[0-9a-f]{40}$';
alter table attestor_proposals rename column wallet to address;
alter table attestor_proposals add constraint attestor_proposals_address_check check (address ~ '^0x[0-9a-f]{40}$');
-- the account a proposal names is the one the key was linked to when proposed; a revocation needs no link (it grants
-- nothing), so a revocation of a key linked to no account names none
alter table attestor_proposals alter column account_id drop not null;
comment on column attestor_proposals.active is 'true: registerAttestor proposed (or the new key of a rotation); false: revokeAttestor proposed (or the old key of a rotation)';

-- Pre-S4 work addressed to an attestor that is not a 20-byte key can never be decided by one (no key has that address,
-- and the chains register keys only). Each such item that is still open is closed once, here, with
-- decision_code 'superseded-s4' and a terminal state its table allows (amendment fix 2; MIG/029 converts only the
-- extinguishment requests this migration leaves). The issuer opens it again, addressed to a registered key.
--
-- hardship: pending → rejected (an allowed state; the issuer may request again, as after any rejection)
update hardship_requests set state = 'rejected', decision_code = 'superseded-s4', decided_at = now()
 where state = 'pending' and attestor !~ '^0x[0-9a-f]{40}$';

-- tier-3 cases gain a decision code. An open case → withdrawn (allowed). A signed case whose quarter no report has
-- reached the chain with (submitted, accepted or paid) is withdrawn too: its signature is a wallet's, which no chain
-- takes now, and while it stands the quarter cannot be opened again (one open or signed case per quarter).
alter table tier3_cases add column if not exists decision_code text;
update tier3_cases c set state = 'withdrawn', decision_code = 'superseded-s4'
 where c.attestor !~ '^0x[0-9a-f]{40}$'
   and (c.state = 'open'
        or (c.state = 'signed' and not exists (select 1 from reports r where r.series_id = c.series_id and r.period_id = c.period_id and r.state in ('submitted', 'accepted', 'paid'))));

-- annual attestations had no terminal state but signed: withdrawn joins the check, with a decision code; one live
-- attestation per series and year (a withdrawn one no longer blocks a new one)
alter table tier3_annual add column if not exists decision_code text;
alter table tier3_annual drop constraint if exists tier3_annual_state_check;
alter table tier3_annual add constraint tier3_annual_state_check check (state in ('open', 'signed', 'withdrawn'));
alter table tier3_annual drop constraint if exists tier3_annual_series_id_year_key;
create unique index if not exists tier3_annual_live on tier3_annual (series_id, year) where state <> 'withdrawn';
update tier3_annual set state = 'withdrawn', decision_code = 'superseded-s4'
 where state = 'open' and attestor !~ '^0x[0-9a-f]{40}$';

-- FX fallback requests are addressed to no attestor while open (any registered key on the chain may sign). A request
-- signed by a wallet that is not a key, whose rate no report has reached the chain with, is opened again for a key to
-- sign: closing it would hold its (chain, pair, period) for good (one request each, and the keeper opens none again).
-- The decision code says why until a key signs it.
alter table fx_fallback_requests add column if not exists decision_code text;
update fx_fallback_requests f set state = 'open', attestor = null, rate_wad = null, signature = null, source_note = null, signed_at = null, decision_code = 'superseded-s4'
 where f.state = 'signed' and f.attestor !~ '^0x[0-9a-f]{40}$'
   and not exists (select 1 from reports r where r.series_id like f.chain || ':%' and r.period_id = f.period_id and r.pair = f.pair and r.fx_basis = 'attestor' and r.state in ('submitted', 'accepted', 'paid'));

-- extinguishment requests: built → withdrawn (joins the check), with a decision code, when either attestor is not a key
alter table extinguishment_requests add column if not exists decision_code text;
alter table extinguishment_requests drop constraint if exists extinguishment_requests_state_check;
alter table extinguishment_requests add constraint extinguishment_requests_state_check check (state in ('built', 'sent', 'withdrawn'));
update extinguishment_requests set state = 'withdrawn', decision_code = 'superseded-s4'
 where state = 'built' and exists (select 1 from unnest(attestors) a where a !~ '^0x[0-9a-f]{40}$');

-- amendments attested by a wallet that is not a key (attested, or built and not applied: the series does not carry the
-- new commitment) → rejected (allowed), with a decision code; a proposed amendment names no attestor yet and stays
alter table terms_amendments add column if not exists decision_code text;
update terms_amendments a set state = 'rejected', decision_code = 'superseded-s4'
 where a.attestor !~ '^0x[0-9a-f]{40}$'
   and (a.state = 'attested'
        or (a.state = 'submitted' and not exists (select 1 from series s where s.series_id = a.series_id and s.terms_commitment = a.new_commitment)));

-- reports assembled with a tier-3 co-signer or an FX rate signer that is not a key and not yet submitted can never be
-- sent (no chain registers that signer): superseded, as 024 did for the ed25519 attestation; reports already on a chain
-- keep their record
update reports set state = 'superseded', updated_at = now()
 where state in ('assembled', 'rejected')
   and ((attestor is not null and attestor !~ '^0x[0-9a-f]{40}$')
        or (attestor_rate is not null and attestor_rate->>'attestor' is not null and attestor_rate->>'attestor' !~ '^0x[0-9a-f]{40}$'));

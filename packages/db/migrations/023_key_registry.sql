-- S4 WP5: Stage 1's key registry. An attestor key is registered or revoked (forward-only, SPEC §1.4): the indexer keeps
-- when it last became active (`registered_at`, the block time of the AttestorRegistered that activated it) and when it
-- was revoked (`revoked_at`, AttestorRevoked's own time; null while active). Report and FX signatures of periods that
-- ended by `revoked_at` stay valid on the chain until `revoked_at` + 45 days (Stage 1's grace); attestor access ends
-- at once (A-M5-2). `updated_seq` is the event that last wrote the row, so a replayed or older event never undoes a
-- later one (as `allowlist.updated_seq`). Times are unix seconds, as every other chain time in the read model.
--
-- Rows indexed before this migration were written by the boolean AttestorRegistered{active}: they keep `active`, with
-- no registration or revocation time, and `updated_seq` 0 (amendment fix 2: a default for existing rows), so the next
-- event about the key overwrites them. A simulator reset (S4 WP5, RUNBOOK) re-indexes every simulator chain anyway.
alter table attestors add column if not exists registered_at bigint;
alter table attestors add column if not exists revoked_at bigint;
alter table attestors add column if not exists updated_seq bigint not null default 0;

-- the multisig requests gain the registry's revoke and rotate for both key kinds (verifier keys by address arrive with
-- S4 WP6; the kinds are added once here)
alter table admin_tx_requests drop constraint if exists admin_tx_requests_kind_check;
alter table admin_tx_requests add constraint admin_tx_requests_kind_check check (kind in (
  'registerAttestor', 'revokeAttestor', 'rotateAttestor',
  'registerVerifierKey', 'revokeVerifierKey', 'rotateVerifierKey',
  'pauseNewRaises', 'setFeeCollector', 'registerSplitRouter'
));

-- requests recorded before S4 hold the boolean command registerAttestor{attestor, active}: re-expressed once in the
-- registry's vocabulary, so every stored command parses as today's AdminCommand (active=true is a registerAttestor,
-- active=false the revokeAttestor it now is). Only rows that still carry `active` change.
update admin_tx_requests
   set kind = 'revokeAttestor', command = jsonb_build_object('kind', 'revokeAttestor', 'attestor', command->>'attestor')
 where kind = 'registerAttestor' and command ? 'active' and command->>'active' = 'false';
update admin_tx_requests
   set command = command - 'active'
 where kind = 'registerAttestor' and command ? 'active';

-- a proposal is a register (active) or a revoke (inactive); rotations are proposed through their tx request (S4 WP7
-- moves proposals to keys linked by proof)
comment on column attestor_proposals.active is 'true: registerAttestor proposed; false: revokeAttestor proposed (S4 WP5)';

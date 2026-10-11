-- S4 WP6: the report verifier's keys as Stage 1 registers them (D10): a secp256k1 key's 20-byte address per chain (it
-- was an ed25519 key named by a key id, never indexed). The indexer projects VerifierKeyRegistered / VerifierKeyRevoked
-- as it projects the attestor keys (023): `registered_at` is when the key last became active, `revoked_at` its
-- forward-only revocation (null while active), after which tier-2 attestations of periods that ended by then stay valid
-- on the chain until `revoked_at` + 45 days; `updated_seq` keeps a replayed or older event from undoing a later one.
-- Times are unix seconds. The services read the chain's own registry (`getSignerKey`); this table is the read model.
create table if not exists verifier_keys (
  chain text not null,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  active boolean not null,
  registered_at bigint,
  revoked_at bigint,
  updated_seq bigint not null default 0,
  primary key (chain, address)
);

-- Multisig requests stored before S4 WP6 for an ed25519 verifier key (registerVerifierKey{keyId, publicKey, active})
-- name no address, so no chain can carry them and they cannot be re-expressed in today's AdminCommand. Every one was
-- built for a simulator chain (the live adapters built nothing before S5), and the simulator chains are reset after
-- S4 WP6 (RUNBOOK "Simulator state version 5: reset"): they are removed, so every stored command parses as today's
-- AdminCommand. The audit log keeps their proposal (`verifier-key.register`), append-only.
delete from admin_tx_requests where kind = 'registerVerifierKey' and command ? 'keyId';

-- Reports assembled before S4 WP6 carry the ed25519 attestation v1 (a key id), which no chain accepts any more: a report
-- not yet submitted is superseded (the issuer assembles it again and the device asks the verifier for Stage 1's REPORT
-- signature); a report already on a chain keeps its stored attestation as the record it is.
update reports set state = 'superseded', updated_at = now()
 where state in ('assembled', 'rejected') and attestation is not null and attestation ? 'keyId';

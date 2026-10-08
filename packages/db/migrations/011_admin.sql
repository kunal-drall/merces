-- E13 admin API. Admins never hold funds and never sign: every chain action is built as an UnsignedTx for the
-- protocol multisig (ChainInfo.admin) and tracked here from proposal to confirmation. The row holds the canonical
-- command (addresses, key material that is public, booleans) and who proposed it; never a document, a figure or a
-- reason. Confirmation is established by reading the chain (listAttestors / listVerifierKeys / info), not trusted
-- from the caller.

create table if not exists admin_tx_requests (
  request_id text primary key,
  kind text not null check (kind in ('registerAttestor','registerVerifierKey','pauseNewRaises','setFeeCollector','registerSplitRouter')),
  chain text not null,
  command jsonb not null,                              -- the AdminCommand as built
  state text not null default 'proposed' check (state in ('proposed','sent','confirmed')),
  tx_id text,                                          -- reported by the admin once the multisig broadcast it
  created_by text not null,                            -- admin account id
  meta jsonb not null default '{}'::jsonb,             -- registerAttestor: {accountId, jurisdiction, kind}; codes only
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  confirmed_at timestamptz
);
create index if not exists admin_tx_requests_state on admin_tx_requests (state, created_at desc);
create index if not exists admin_tx_requests_chain_kind on admin_tx_requests (chain, kind, created_at desc);

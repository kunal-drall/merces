-- A-M5-2: proposing an attestor grants nothing. The proposal is recorded here; attestor access starts only once the
-- multisig's registerAttestor is onchain and indexed (the `attestors` table), and ends when a deactivation is indexed.
create table if not exists attestor_proposals (
  chain text not null,
  wallet text not null,
  account_id text not null,
  active boolean not null,
  request_id text,
  proposed_by text not null,
  proposed_at timestamptz not null default now(),
  primary key (chain, wallet)
);

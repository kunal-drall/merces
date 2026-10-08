-- E11 fees and accounting (R33). The fee ledger and money events are projected by the indexer (002_indexer.sql);
-- this module adds the reconciliation runs that compare those indexed totals with onchain state.
-- Every column is an amount, a count or a status: no income figures, no documents, no reasons.

create table if not exists reconciliation_runs (
  run_id text primary key,
  at timestamptz not null default now(),
  actor text not null,                                -- admin account that ran it
  ok boolean not null,                                -- every check ok
  checks_total int not null,
  checks_failed int not null,
  checks jsonb not null                               -- [{check, chain, seriesId, stablecoin, indexed, onchain, delta, ok, note?}] amounts as strings
);
create index if not exists reconciliation_runs_at on reconciliation_runs (at desc);

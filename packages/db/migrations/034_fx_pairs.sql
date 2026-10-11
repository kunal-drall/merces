-- The registry owns feed/inversion identity and cross-check configuration.
alter table rate_pairs add column inverted boolean not null default false;
alter table rate_pairs add column crosscheck_effective_period text;
alter table series add column fx_pair_id text;
alter table admin_tx_requests drop constraint admin_tx_requests_kind_check;
alter table admin_tx_requests add constraint admin_tx_requests_kind_check check (kind in (
  'registerIssuer', 'registerAttestor', 'revokeAttestor', 'rotateAttestor', 'registerVerifierKey',
  'revokeVerifierKey', 'rotateVerifierKey', 'pauseNewRaises', 'setFeeCollector', 'registerSplitRouter', 'setFxPair'
));

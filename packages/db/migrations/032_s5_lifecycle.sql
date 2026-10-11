-- S5: issuer registration is a protocol-admin proposal; window terms belong to each series.
alter table admin_tx_requests drop constraint if exists admin_tx_requests_kind_check;
alter table admin_tx_requests add constraint admin_tx_requests_kind_check check (kind in (
  'registerIssuer', 'registerAttestor', 'revokeAttestor', 'rotateAttestor',
  'registerVerifierKey', 'revokeVerifierKey', 'rotateVerifierKey',
  'pauseNewRaises', 'setFeeCollector', 'registerSplitRouter'
));
-- Old indexed records remain unknown until replayed; never invent committed terms for a historical series.
alter table series add column if not exists window_commit_duration bigint;
alter table series add column if not exists window_reveal_duration bigint;
alter table series add column if not exists window_fee_bps integer;

alter table issuers add column if not exists active boolean not null default true;
alter table admin_tx_requests drop constraint if exists admin_tx_requests_kind_check;
alter table admin_tx_requests add constraint admin_tx_requests_kind_check check (kind in ('registerIssuer','deactivateIssuer','registerAttestor','revokeAttestor','rotateAttestor','registerVerifierKey','revokeVerifierKey','rotateVerifierKey','pauseNewRaises','setFeeCollector','registerSplitRouter','setFxPair','setFlags'));

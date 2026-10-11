alter table transfer_windows add column period_id text;
alter table transfer_windows add column state text not null default 'Commit';
alter table transfer_windows add column proposed_price numeric(78,0);
alter table transfer_windows add column tally_round integer not null default 0;
alter table transfer_windows add column round_rejected boolean not null default false;
alter table transfer_windows add column tallied_count integer not null default 0;
create table window_orders (
 series_id text not null, window_id integer not null, owner text not null,
 side text not null check(side in ('buy','sell')), commitment text not null, escrow numeric(78,0) not null,
 revealed boolean not null default false, valid boolean not null default false,
 price numeric(78,0), quantity numeric(78,0), reveal_index integer not null default -1,
 processed boolean not null default false, delivered boolean not null default false,
 fill numeric(78,0) not null default 0, fee numeric(78,0) not null default 0,
 pending_units numeric(78,0) not null default 0, pending_stable numeric(78,0) not null default 0,
 cancelled boolean not null default false,
 primary key (series_id,window_id,owner), foreign key (series_id,window_id) references transfer_windows(series_id,window_id) on delete cascade
);

alter table admin_tx_requests drop constraint admin_tx_requests_kind_check;
alter table admin_tx_requests add constraint admin_tx_requests_kind_check check (kind in (
 'registerIssuer','registerAttestor','revokeAttestor','rotateAttestor','registerVerifierKey','revokeVerifierKey',
 'rotateVerifierKey','pauseNewRaises','setFeeCollector','registerSplitRouter','setFxPair','setFlags'
));

create table window_delivery_retries (
 series_id text not null, window_id integer not null, owner text not null,
 attempts integer not null, next_at bigint not null, last_error text not null,
 primary key (series_id,window_id,owner)
);

-- S2 WP3: Stage 1's multi-step auction settlement in the read model (SPEC §5.2), projected by the indexer from
-- SettlementProposed, SettlementRejected, UnitsAllocated, BidDelivered, RaiseMintFinalized, HolderRegistered and the
-- auction's AuctionSettled / AuctionFailed. Everything here is public onchain state (bids, allocations, deliveries,
-- rounds); none of it is an income figure.
-- The non-reveal charge is an owner hold (not modelled): no column records it.

-- the auction record on the series: the current round, its results (a failed raise keeps its price and would-be
-- results here; the series' issue price stays unset) and the mint gate
alter table series add column if not exists mint_finalized boolean not null default false;
alter table series add column if not exists settlement_round int not null default 0;
alter table series add column if not exists round_rejected boolean not null default false;
alter table series add column if not exists rejection_reason text;
alter table series add column if not exists auction_clearing_price numeric(38,0);
alter table series add column if not exists auction_units_sold numeric(38,0) not null default 0;
alter table series add column if not exists auction_proceeds numeric(38,0) not null default 0;
alter table series add column if not exists auction_failure_reason text;
alter table series add column if not exists auction_finalized_at bigint;

-- each bid's validity (fixed at reveal), processing and delivery; pending values are 0 once delivered
alter table bids add column if not exists valid boolean;
alter table bids add column if not exists processed boolean not null default false;
alter table bids add column if not exists cost numeric(38,0) not null default 0;
alter table bids add column if not exists fee numeric(38,0) not null default 0;
alter table bids add column if not exists pending_units numeric(38,0) not null default 0;
alter table bids add column if not exists pending_refund numeric(38,0) not null default 0;
alter table bids add column if not exists delivered boolean not null default false;
alter table bids add column if not exists delivered_units numeric(38,0) not null default 0;

-- a winner's units count toward its position (its accrual weight) from processing; the part not yet delivered, and
-- Stage 1's holder registration
alter table positions add column if not exists undelivered_units numeric(38,0) not null default 0;
alter table positions add column if not exists registered boolean not null default false;

-- every settlement round proposed for a series, and how it ended
create table if not exists settlement_rounds (
  series_id text not null,
  round int not null,
  clearing_price numeric(38,0) not null,
  proposed_seq bigint not null,
  rejected boolean not null default false,
  rejection_reason text,
  primary key (series_id, round)
);

-- the keepers' delivery attempts per bid (S2 WP6). `last_error` holds an error name or code only, never a message
-- (adapter messages can embed values)
create table if not exists auction_deliveries (
  series_id text not null,
  bidder text not null,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  stuck_notified_at timestamptz,
  primary key (series_id, bidder)
);

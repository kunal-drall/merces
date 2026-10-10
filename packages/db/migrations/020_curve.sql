-- S3 WP8: curve mode on Stage 1 in the read model, every S3 curve column at once (the census, staking and tendering
-- fill theirs from WP9 and WP10). Projected by the indexer from CurveActivated, CurveGraduated (Stage 1 RaiseSettled
-- on a curve), CurveProceedsCollected and, later, CurveUnitsSynced, UnitsStaked and UnitsUnstaked. Everything here is
-- public onchain state (the pool's target and progress, its proceeds, the census, stakes); none of it is an income
-- figure. Curve quantities are base lamports (10^6 per whole unit); prices per whole unit.

-- the series' accounting unit (Stage 1 `Ledger.unit_scale`: 1, or 10^6 base lamports on a curve), the stake and tender
-- totals and the time of the last census (Stage 1 `units_synced_at`)
alter table series add column if not exists unit_scale numeric(38,0) not null default 1;
alter table series add column if not exists staked_total numeric(38,0) not null default 0;
alter table series add column if not exists tendered_total numeric(38,0) not null default 0;
alter table series add column if not exists units_synced_at bigint;
update series set unit_scale = 1000000 where raise_style = 'curve';

-- a holder's units in the series' stake vault (curve mode: only staked units earn)
alter table positions add column if not exists staked_units numeric(38,0) not null default 0;

-- the curve, reshaped for Stage 1's lifecycle: activation fixes the pool, P0 and the units sold; completion settles at
-- the pool's finish time; collection funds the treasury. The toy curve's raise and graduation flags are gone (a curve
-- buy never funds the treasury)
drop table if exists curves;
create table curves (
  series_id text primary key,
  dbc_config text not null,
  dbc_pool text not null,
  base_mint text not null,
  dbc_creator text not null,
  migration_quote_threshold numeric(38,0) not null,
  issue_price numeric(38,0) not null,
  units_sold numeric(38,0) not null,
  completed boolean not null default false,
  settled_at bigint,
  proceeds numeric(38,0) not null default 0,
  migration_fee numeric(38,0) not null default 0,
  surplus numeric(38,0) not null default 0,
  trading_fee numeric(38,0) not null default 0
);

-- every census of a curve series (Stage 1 CurveUnitsSynced): units outstanding = supply − protocol-held
create table if not exists curve_census (
  series_id text not null,
  seq bigint not null,
  supply numeric(38,0) not null,
  protocol_held numeric(38,0) not null,
  units_outstanding numeric(38,0) not null,
  staked_total numeric(38,0) not null,
  synced_at bigint not null,
  primary key (series_id, seq)
);

-- the curve monitor records what it read and did: the toy curve's raised total and graduation flag are gone
alter table curve_monitor drop column if exists raised;
alter table curve_monitor drop column if exists graduated;
alter table curve_monitor add column if not exists quote_reserve numeric(38,0);
alter table curve_monitor add column if not exists pool_complete boolean not null default false;
alter table curve_monitor add column if not exists settled boolean not null default false;
alter table curve_monitor add column if not exists actions text[] not null default '{}';

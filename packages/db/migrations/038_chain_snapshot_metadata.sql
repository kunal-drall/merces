-- EVM FxSnapshot deliberately omits Pyth confidence/publication time. Preserve absence instead of inventing values.
alter table rate_snapshots alter column conf_wad drop not null;
alter table rate_snapshots alter column publish_time drop not null;

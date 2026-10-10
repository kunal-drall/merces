-- S2 WP2: the sealed-bid raise's own terms (Stage 1 create_series): the commit and reveal durations and the non-reveal
-- charge, projected by the indexer from SeriesCreated. Nullable: rows indexed before S2 carry none (a simulator chain
-- is reset at S2, so only a live chain's older rows could). Public terms, never an income figure.
-- The non-reveal charge is an owner hold (not modelled): series created during the hold record 0.
alter table series add column if not exists commit_duration_seconds bigint;
alter table series add column if not exists reveal_duration_seconds bigint;
alter table series add column if not exists non_reveal_charge_bps int;

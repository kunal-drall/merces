-- S3 WP11: the curve keepers. The lifecycle job (`curve.lifecycle`) records each check it acts on, or whose read
-- changed, in curve_monitor; `chain_time` is the chain's time of the check (the keepers run on chain time, never the
-- wall clock), so the weekly collection of the partner's trading fees is counted on the chain's clock. Public onchain
-- facts only (the pool's reserve and progress, the lifecycle steps sent); nothing here is an income figure.
alter table curve_monitor add column if not exists chain_time bigint;

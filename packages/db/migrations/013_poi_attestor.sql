-- E5: persist the tier-3 attestor on the report so submitReport carries the co-signer.
alter table reports add column if not exists attestor text;

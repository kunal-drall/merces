-- Vendor credentials remain local. Contract payloads/results in the relay are encrypted at rest.
alter table local_operator_jobs drop constraint local_operator_jobs_kind_check;
alter table local_operator_jobs add constraint local_operator_jobs_kind_check check (kind in ('service','verifier','provider'));

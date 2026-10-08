-- Idempotency keys are reserved before the write runs, so a concurrent duplicate waits on the reservation (409
-- "in progress") instead of executing the write a second time. A reservation is 'pending' until the response is stored.
alter table idempotency_keys alter column status_code drop not null;
alter table idempotency_keys alter column response drop not null;
alter table idempotency_keys add column if not exists state text not null default 'done';

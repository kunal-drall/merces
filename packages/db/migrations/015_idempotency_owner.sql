-- Each reservation carries an owner token: after a stale reservation is taken over, the original request can no
-- longer release or complete the row (only the current owner can).
alter table idempotency_keys add column if not exists owner text;

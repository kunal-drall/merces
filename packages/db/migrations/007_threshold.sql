-- E9 threshold data service (R34): admin side of the curated threshold table (004_threshold_data.sql).
-- threshold_data_history is append-only: every insert, update and delete of a threshold row is recorded with the
-- resulting values (for a delete: the values removed), who changed it and when. These are public statistics, never a
-- person's income.

create table if not exists threshold_data_history (
  id bigserial primary key,
  at timestamptz not null default now(),
  country text not null,
  year int not null,
  op text not null check (op in ('insert','update','delete')),
  currency text not null,
  median_full_time_income numeric(38,0) not null,   -- annual, in currency base units (6 decimals)
  inflation_index_bps int not null,
  source text not null,
  source_url text,
  retrieved_at date not null,
  placeholder boolean not null,
  changed_by text not null
);
create index if not exists threshold_data_history_key on threshold_data_history (country, year, id);
create or replace function threshold_data_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'threshold_data_history is append-only';
end $$;
drop trigger if exists threshold_data_history_no_update on threshold_data_history;
create trigger threshold_data_history_no_update before update or delete on threshold_data_history for each row execute function threshold_data_history_immutable();

-- Yearly indexing nudges: one 'indexing.due' notification per series and year (POST /admin/indexing/{year}/notify is
-- idempotent because of this ledger). outbox_id is filled in the same transaction that inserts the row.
create table if not exists indexing_notifications (
  series_id text not null,
  year int not null,
  country text not null,
  inflation_index_bps int not null,
  outbox_id bigint,
  notified_by text not null,
  notified_at timestamptz not null default now(),
  primary key (series_id, year)
);

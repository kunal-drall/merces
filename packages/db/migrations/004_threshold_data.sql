-- E9: curated median full-time income and inflation index by country and year. Admin-edited only.
-- Seeded with clearly marked PLACEHOLDER rows (A-DATA-1); every row carries its public source and retrieval date.
create table if not exists threshold_data (
  country text not null,
  year int not null,
  currency text not null,
  median_full_time_income numeric(38,0) not null,   -- annual, in currency base units (6 decimals)
  inflation_index_bps int not null,                 -- year-over-year CPI change in basis points, applied to θ at indexing
  source text not null,
  source_url text,
  retrieved_at date not null,
  placeholder boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (country, year)
);

insert into threshold_data (country, year, currency, median_full_time_income, inflation_index_bps, source, source_url, retrieved_at, placeholder, updated_by) values
  ('US', 2026, 'USD', 60000000000, 300, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed'),
  ('GB', 2026, 'GBP', 37000000000, 300, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed'),
  ('DE', 2026, 'EUR', 50000000000, 250, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed'),
  ('IN', 2026, 'INR', 600000000000, 500, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed'),
  ('CA', 2026, 'CAD', 60000000000, 300, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed'),
  ('SG', 2026, 'SGD', 65000000000, 300, 'PLACEHOLDER — ask Kunal for source (Part J.4)', null, '2026-10-07', true, 'seed')
on conflict (country, year) do nothing;

-- S4 WP9: tier 3 and the FX fallback carry Stage 1's own signatures (S4 D8 steps 12 and 16, D14).
--
-- A tier-3 report carries an attestor key's `MERCES_REPORT_V1` signature with tier 3 (`submitReport.attestation`, as a
-- tier-2 report carries the report verifier's), made on the attestor's own device over the chain's signing domain and
-- the series key. The FX fallback carries an attestor key's `MERCES_FX_V1` signature over the series key, the period and
-- the rate (`submitReport.fxFallback`): the message binds the series key, so one attestor rate is one signature per
-- series. Nobody co-signs a report any more. Every column here holds addresses, signatures, digests, rates, period ids
-- and series ids: public data once on a chain, never an income figure, a salt or an opening.

-- The FX fallback request stays per (chain, pair, period) (the keeper opens one; MIG/006); its signatures are per series.
-- `chain` repeats the request's so a simulator reset removes the signatures with the requests (SIM_RESET_CHAIN_TABLES).
create table if not exists fx_fallback_signatures (
  request_id text not null references fx_fallback_requests(request_id),
  chain text not null,
  series_id text not null,
  signer text not null check (signer ~ '^0x[0-9a-f]{40}$'),
  rate_wad numeric(20,0) not null check (rate_wad > 0),
  signature text not null check (signature ~ '^0x[0-9a-f]{130}$'),
  digest text not null check (digest ~ '^0x[0-9a-f]{64}$'),
  signed_at timestamptz not null default now(),
  primary key (request_id, series_id)
);
create index if not exists fx_fallback_signatures_series on fx_fallback_signatures (series_id);

-- A request signed before S4 WP9 holds one EIP-191 text signature for the pair (S4 WP7-WP8), which no chain takes. When
-- no report reached a chain with its rate, it is opened again for a key to sign Stage 1's FX message per series (as
-- MIG/025 did for a wallet's signature: closing it would hold its (chain, pair, period) for good); the decision code says
-- why until a key signs it. A request whose rate a report did reach a chain with keeps its signer and rate as history.
-- The text signature column goes: the signatures are fx_fallback_signatures' rows now.
update fx_fallback_requests f set state = 'open', attestor = null, rate_wad = null, source_note = null, signed_at = null, decision_code = 'superseded-s4'
 where f.state = 'signed'
   and not exists (select 1 from fx_fallback_signatures s where s.request_id = f.request_id)
   and not exists (select 1 from reports r where r.series_id like f.chain || ':%' and r.period_id = f.period_id and r.pair = f.pair and r.fx_basis = 'attestor' and r.state in ('submitted', 'accepted', 'paid'));
alter table fx_fallback_requests drop column if exists signature;

-- Reports. One not yet submitted that was assembled with a co-signer (a tier-3 attestor, or an FX rate signer) can never
-- be sent now: superseded, as MIG/024 and MIG/025 did (the issuer assembles it again and the service carries the stored
-- signatures). A report already on a chain keeps its record.
update reports set state = 'superseded', updated_at = now()
 where state in ('assembled', 'rejected') and (tier = 3 or attestor_rate is not null);
-- `attestor_rate` ({attestor, rateWad}: a co-signer) becomes `fx_fallback` ({signer, signature}: the FX signature for
-- this series, as the command carries it). A pre-S4 WP9 value holds no signature; it is cleared (the rate stays in
-- fx_avg_wad, its signer in fx_fallback_requests.attestor).
alter table reports rename column attestor_rate to fx_fallback;
update reports set fx_fallback = null where fx_fallback is not null and not (fx_fallback ? 'signer' and fx_fallback ? 'signature');
comment on column reports.fx_fallback is 'the FX fallback: {signer, signature}, an attestor key''s Stage 1 MERCES_FX_V1 signature for this series (S4 WP9); null when the accumulator rate applies';
-- `attestor` (the tier-3 co-signer, MIG/013) goes: a tier-3 report's `attestation` holds the attestor key's REPORT
-- signature {signer, signature}, as a tier-2 report's holds the verifier's.
alter table reports drop column if exists attestor;
comment on column reports.attestation is 'Stage 1''s REPORT signature {signer, signature}: tier 2 the report verifier key''s (S4 WP6), tier 3 an attestor key''s (S4 WP9); null for tiers 1 and 4';

-- tier3_cases.attestation holds {signer, signature, digest}: the attestor key's REPORT signature with tier 3 (was
-- {attestor, liquidityEvent, signature}, an EIP-191 text signature, S4 WP7-WP8). A case signed that way whose quarter no
-- report reached a chain with is opened again for its key to sign Stage 1's message (its documents and opening stay, so
-- the issuer does nothing; the decision code says why until the key signs). A case whose report is on a chain keeps its
-- record.
update tier3_cases c set state = 'open', attestation = null, attested_payment_stable = null, proof = null, signed_at = null, decision_code = 'superseded-s4'
 where c.state = 'signed'
   and not (coalesce(c.attestation, '{}'::jsonb) ? 'signer' and coalesce(c.attestation, '{}'::jsonb) ? 'digest')
   and not exists (select 1 from reports r where r.series_id = c.series_id and r.period_id = c.period_id and r.state in ('submitted', 'accepted', 'paid'));
comment on column tier3_cases.attestation is 'the attestor key''s Stage 1 REPORT signature with tier 3: {signer, signature, digest} (S4 WP9)';

-- S1 WP10: Stage 1's report proof format offchain. Every column added here holds commitments, proofs, ciphertext,
-- period ids or amounts already public onchain; never an income figure, a salt or an opening.

-- the income commitment a report chains from (Stage 1 prior chain; ZERO at a year start)
alter table reports add column if not exists prior_income_commitment text;
alter table periods add column if not exists prior_income_commitment text;

-- tier 3 (critique M7): the issuer's device proves; the attestor checks the commitments against the documents with
-- the opening, which travels end to end encrypted for the attestor like the documents (opaque here, never decrypted).
-- The attestor's signed case carries commitments, the proof and the attestation only.
alter table tier3_cases add column if not exists opening_ciphertext text;
alter table tier3_cases add column if not exists prior_income_commitment text;
alter table tier3_cases add column if not exists proof jsonb;
alter table tier3_cases add column if not exists attestation jsonb;

-- critique M8: Stage 1's reporting ledger in the series read model, projected by the indexer from SeriesCreated /
-- AuctionSettled / CurveGraduated (first period), ReportAccepted (accepted, income chain head, open due),
-- PaymentReceived (paid, open due cleared), SeriesRetired and SeriesExtinguished (open due cleared) and
-- FormalNoticeDue. The API serves these columns (one source with the rest of `series`), not live chain reads. Period
-- ids are "YYYYQn".
alter table series add column if not exists first_period text;
alter table series add column if not exists next_expected_period text;
alter table series add column if not exists last_accepted_period text;
alter table series add column if not exists last_paid_period text;
alter table series add column if not exists open_due_period text;
alter table series add column if not exists open_due_amount numeric(38,0) not null default 0;
alter table series add column if not exists last_income_period text;
alter table series add column if not exists last_income_commitment text;
alter table series add column if not exists formal_notice_emitted_for text;

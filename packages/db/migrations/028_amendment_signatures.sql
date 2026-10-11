-- S4 WP11: an amendment carries the attestor key's own Stage 1 signature (S4 D8).
--
-- Stage 1's `amend_terms` is the issuer's transaction and takes the attestor's `MERCES_AMEND_V1` signature over the
-- series' amendment nonce, the new terms commitment and the new cap multiple as an argument: the attestor signs on their
-- own device (the API never signs), the terms service checks the signature and the live nonce, and the issuer's
-- `amendTerms` carries it. Nobody co-signs.
--
-- `attestor_signature` (003) was never used before; it now holds that signature, with the nonce it binds and its digest.
-- Every column here holds a nonce, an address, a signature or a digest. Until the chain accepts it, the signature
-- appears in the issuer's built transaction only: never in a list, the activity feed, a notification or the audit log
-- (S4 amendment D2).

alter table terms_amendments add column if not exists amendment_nonce numeric(20,0) check (amendment_nonce >= 0 and amendment_nonce <= 18446744073709551615);
alter table terms_amendments add column if not exists digest text check (digest ~ '^0x[0-9a-f]{64}$');
alter table terms_amendments drop constraint if exists terms_amendments_attestor_signature_check;
alter table terms_amendments add constraint terms_amendments_attestor_signature_check check (attestor_signature ~ '^0x[0-9a-f]{130}$');
comment on column terms_amendments.amendment_nonce is 'the series amendment nonce the AMEND signature binds (S4 WP11)';
comment on column terms_amendments.digest is 'the Stage 1 AMEND digest the attestor signed (S4 WP11)';
comment on column terms_amendments.attestor_signature is 'the attestor key''s Stage 1 AMEND signature (S4 WP11); the issuer''s amendTerms carries it';

-- Rows attested by a key before S4 WP11 carry no signature: no amendTerms can be built for them any more (the command
-- takes the AMEND signature), so they go back to awaiting an attestor, who signs on their device. The same for a row
-- built before S4 WP11 (the attestor co-signing) that the chain does not carry yet: that transaction can no longer land.
-- Rows that landed (the series carries the new commitment) keep their record and are applied as before. Rows 025 closed
-- (rejected, superseded-s4) are not touched again.
update terms_amendments a set state = 'proposed', attestor = null, decision_code = 'resign-s4'
 where a.attestor_signature is null
   and (a.state = 'attested'
        or (a.state = 'submitted' and not exists (select 1 from series s where s.series_id = a.series_id and s.terms_commitment = a.new_commitment)));

-- the signature, its nonce and its digest go together; an attested row has them (a submitted or applied row from before
-- S4 WP11 that landed has none)
alter table terms_amendments drop constraint if exists terms_amendments_signature_check;
alter table terms_amendments add constraint terms_amendments_signature_check check (
  (attestor_signature is null) = (digest is null)
  and (digest is null) = (amendment_nonce is null)
  and (attestor_signature is null or (state in ('attested', 'submitted', 'applied') and attestor is not null))
  and (state <> 'attested' or attestor_signature is not null)
);

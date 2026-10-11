-- S4 WP13: the annual true-up carries the attestor key's own Stage 1 TRUEUP signature (S4 D13).
--
-- Stage 1's `submit_trueup` is the issuer's transaction and takes the attestor's `MERCES_TRUEUP_V1` signature over the
-- series' true-up nonce, the year, the signed adjustment (positive: owed to holders, due 60 days after the attestation;
-- negative: credited forward, at most the year's accepted report payments) and the attestation time as arguments. The
-- attestor signs on their own device (the API never signs); the attestor service checks the signature, the live nonce,
-- Stage 1's year rules and its bound on a negative adjustment (S4 amendment D13), and stores it here for the issuer's
-- `submit_trueup`, which lands in S5. Nobody co-signs.
--
-- Every column here holds a nonce, a time, an address, a signature, a digest or the adjustment, a payment figure Stage 1
-- publishes onchain (never income). Until the chain has it, the signature appears in no read, the audit log, a
-- notification or the activity feed (S4 amendment D2): the views show its signer, nonce, time, adjustment and digest.

alter table tier3_annual add column if not exists trueup_nonce numeric(20,0) check (trueup_nonce >= 0 and trueup_nonce <= 18446744073709551615);
alter table tier3_annual add column if not exists attestation_ts numeric(20,0) check (attestation_ts >= 0 and attestation_ts <= 18446744073709551615);
alter table tier3_annual add column if not exists adjustment numeric(20,0) check (adjustment >= -9223372036854775808 and adjustment <= 9223372036854775807);
alter table tier3_annual add column if not exists trueup_signer text check (trueup_signer ~ '^0x[0-9a-f]{40}$');
alter table tier3_annual add column if not exists trueup_signature text check (trueup_signature ~ '^0x[0-9a-f]{130}$');
alter table tier3_annual add column if not exists trueup_digest text check (trueup_digest ~ '^0x[0-9a-f]{64}$');
comment on column tier3_annual.trueup_nonce is 'the series true-up nonce the TRUEUP signature binds (S4 WP13)';
comment on column tier3_annual.attestation_ts is 'the attestation time the TRUEUP signature binds, unix seconds (Stage 1 attestation_ts; S4 WP13)';
comment on column tier3_annual.adjustment is 'the signed true-up adjustment, total less what was paid on estimate (Stage 1 i64; S4 WP13)';
comment on column tier3_annual.trueup_signer is 'the attestor key that signed the TRUEUP message (S4 WP13)';
comment on column tier3_annual.trueup_signature is 'the attestor key''s Stage 1 TRUEUP signature (S4 WP13); the issuer''s submit_trueup carries it (S5); never shown before the chain has it';
comment on column tier3_annual.trueup_digest is 'the Stage 1 TRUEUP digest the attestor signed (S4 WP13)';

-- Attestations signed before S4 WP13 carry amounts only, no TRUEUP signature: Stage 1's submit_trueup could never take
-- them. One addressed to a 20-byte key goes back to open (decision code resign-s4), its amounts cleared: the key signs the
-- year's TRUEUP message on its device. One addressed to a wallet (before S4 WP7) is withdrawn (superseded-s4): a wallet
-- signs no Stage 1 message, and the issuer opens the year again for a key. Rows 025 closed (open ones addressed to a
-- wallet, withdrawn) are not touched again (amendment fix 2).
update tier3_annual set state = 'withdrawn', decision_code = 'superseded-s4'
 where state = 'signed' and trueup_signature is null and attestor !~ '^0x[0-9a-f]{40}$';
update tier3_annual set state = 'open', decision_code = 'resign-s4', total_payment_stable = null, estimated_payment_stable = null,
       overpayment = null, underpayment = null, trueup_due_at = null, credit_period_id = null, signed_at = null
 where state = 'signed' and trueup_signature is null;

-- the signature, its nonce, time, adjustment, signer and digest go together; a signed attestation has them, signed by its
-- own key, and its adjustment is the attested total less what was paid on estimate
alter table tier3_annual drop constraint if exists tier3_annual_trueup_check;
alter table tier3_annual add constraint tier3_annual_trueup_check check (
  num_nonnulls(trueup_nonce, attestation_ts, adjustment, trueup_signer, trueup_signature, trueup_digest) in (0, 6)
  and (state = 'signed') = (trueup_signature is not null)
  and (trueup_signer is null or trueup_signer = attestor)
  and (adjustment is null or adjustment = total_payment_stable - estimated_payment_stable)
);

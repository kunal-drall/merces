-- Annual signatures now progress through an issuer submission and optional payment.
alter table tier3_annual drop constraint tier3_annual_state_check;
alter table tier3_annual add constraint tier3_annual_state_check check (state in ('open','signed','withdrawn','recorded','paid'));
alter table tier3_annual drop constraint tier3_annual_trueup_check;
alter table tier3_annual add constraint tier3_annual_trueup_check check (
  num_nonnulls(trueup_nonce, attestation_ts, adjustment, trueup_signer, trueup_signature, trueup_digest) in (0, 6)
  and (state in ('signed','recorded','paid')) = (trueup_signature is not null)
  and (trueup_signer is null or trueup_signer = attestor)
);
alter table tier3_annual add column recorded_seq bigint;
alter table tier3_annual add column paid_seq bigint;
alter table series add column trueup_nonce numeric(20,0) not null default 0;
alter table series add column trueup_year int;
alter table series add column last_trueup_year int;
alter table series add column trueup_due numeric(20,0) not null default 0;
alter table series add column trueup_deadline bigint;
alter table series add column trueup_notice_seq bigint;

-- S4 WP10: a hardship pause is approved by the attestor key's own Stage 1 signature (S4 D3, D8, D12).
--
-- Stage 1's `approve_pause` takes the attestor's `MERCES_PAUSE_V1` signature over the series' pause nonce and the end as
-- an argument, and anyone may submit it: the attestor signs on their own device (the API never signs), the attestor
-- service checks the signature and the live nonce, and the keeper relays it. The issuer may withdraw its request
-- (`withdraw_pause_request`), which advances the nonce and kills any signature over the withdrawn request.
--
-- Every column here holds a nonce, an address, a signature, a digest, an end time or a transaction id: public data once
-- on a chain. An approval is stored only after the chain accepted it (an unrelayed PAUSE signature is a bearer
-- authorisation, never at rest: S4 amendment D2).

-- the pause nonce of the onchain request this row stands for: from the indexed PauseRequested event while pending (only
-- forward), and the nonce the approval was signed over once approved (the same: an approval leaves the nonce)
alter table hardship_requests add column if not exists pause_nonce numeric(20,0) check (pause_nonce >= 0 and pause_nonce <= 18446744073709551615);
-- the relayed approval: {signer, signature, digest, pauseNonce, pauseEnd}
alter table hardship_requests add column if not exists approval jsonb;
alter table hardship_requests drop constraint if exists hardship_requests_approval_check;
alter table hardship_requests add constraint hardship_requests_approval_check check (
  approval is null
  or (coalesce(approval->>'signer', '') ~ '^0x[0-9a-f]{40}$'
      and coalesce(approval->>'signature', '') ~ '^0x[0-9a-f]{130}$'
      and coalesce(approval->>'digest', '') ~ '^0x[0-9a-f]{64}$'
      and coalesce(approval->>'pauseNonce', '') ~ '^[0-9]{1,20}$'
      and coalesce(approval->>'pauseEnd', '') ~ '^[0-9]{1,20}$')
);
-- the keeper's relay transaction
alter table hardship_requests add column if not exists relay_tx text;
comment on column hardship_requests.approval is 'the relayed approval: the attestor key''s Stage 1 PAUSE signature {signer, signature, digest, pauseNonce, pauseEnd} (S4 WP10); stored once the chain accepted it';
comment on column hardship_requests.pause_nonce is 'the pause nonce of the onchain request (indexed PauseRequested), and the nonce the approval signed';

-- `withdrawn`: the issuer withdrew the onchain request (indexed PauseRequestWithdrawn). A row approved before S4 WP10 keeps
-- its record with no approval: its approvePause was built for the attestor's wallet; if that transaction never landed, the
-- onchain request is still pending, and the issuer withdraws it (POST /series/{id}/hardship/build-withdraw) or the
-- attestor's key approves a new request.
alter table hardship_requests drop constraint if exists hardship_requests_state_check;
alter table hardship_requests add constraint hardship_requests_state_check check (state in ('pending', 'approved', 'rejected', 'withdrawn'));
alter table hardship_requests drop constraint if exists hardship_requests_relay_check;
alter table hardship_requests add constraint hardship_requests_relay_check check ((approval is null) = (relay_tx is null) and (approval is null or state = 'approved'));

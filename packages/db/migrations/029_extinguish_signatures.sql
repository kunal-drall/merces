-- S4 WP12: an extinguishment carries two attestor keys' own Stage 1 signatures (S4 D3, D8, D15).
--
-- Stage 1's `extinguish` takes two attestor keys' `MERCES_EXTINGUISH_V1` signatures over the series' extinguish nonce as
-- arguments, and anyone may submit it: each attestor signs on their own device (the API never signs), the attestor
-- service checks each signature and the live nonce, and once both are in the keeper relays them. Nobody co-signs a
-- transaction any more. The two keys must be linked to two different accounts (D15: ours, stricter than Stage 1).
--
-- A request is `collecting` while it has fewer than two signatures, `ready` with both (the keeper relays it at once; a
-- refused relay leaves it ready with the refusal's code in `relay_error`), `sent` once the chain extinguished the series
-- with them, and `withdrawn` when it can no longer be completed (025's closures, or another extinguishment landed).
--
-- Every column here holds a nonce, an address, a signature, a digest, a code or a transaction id. An unrelayed
-- EXTINGUISH signature is a bearer authorisation (anyone holding both could extinguish the series): it is stored here
-- because the second signer may sign days later, and it is never shown by any read, the audit log, a notification or the
-- activity feed until the chain has it (S4 amendment D2); after the relay it is public onchain data.

alter table extinguishment_requests add column if not exists extinguish_nonce numeric(20,0) check (extinguish_nonce >= 0 and extinguish_nonce <= 18446744073709551615);
-- [{signer, signature, digest}], at most one per named key, all over `extinguish_nonce`
alter table extinguishment_requests add column if not exists signatures jsonb not null default '[]'::jsonb;
-- the keeper's relay transaction (`sent`), and the Stage 1 name or canonical code of the last refused relay (`ready`)
alter table extinguishment_requests add column if not exists relay_tx text;
alter table extinguishment_requests add column if not exists relay_error text;
comment on column extinguishment_requests.extinguish_nonce is 'the series extinguish nonce the stored EXTINGUISH signatures bind (S4 WP12)';
comment on column extinguishment_requests.signatures is 'the named keys'' Stage 1 EXTINGUISH signatures [{signer, signature, digest}] (S4 WP12); bearer authorisations until relayed: never shown before the chain has them';
comment on column extinguishment_requests.relay_tx is 'the keeper''s relay of Stage 1 extinguish carrying both signatures (S4 WP12)';
comment on column extinguishment_requests.relay_error is 'the Stage 1 name (or canonical code) of the last refused relay of a ready request (S4 WP12)';
comment on column extinguishment_requests.attestors is 'the two attestor keys the request names, the opener''s first; linked to two different accounts (S4 D15)';

alter table extinguishment_requests drop constraint if exists extinguishment_requests_state_check;

-- Rows 025 left `built` (both keys 20-byte keys, built for the first key to send with the second co-signing): that
-- transaction can no longer land (extinguish takes two signatures now). A row whose series the read model shows
-- extinguished landed: `sent` (no signatures on record). Every other one goes back to collecting signatures (decision
-- code resign-s4): both named attestors sign on their devices and the keeper relays. Rows 025 closed (withdrawn,
-- superseded-s4) are not touched again (amendment fix 2).
update extinguishment_requests e set state = 'sent'
 where e.state = 'built' and exists (select 1 from series s where s.series_id = e.series_id and s.extinguished_at is not null);
-- (the old flow let two requests for one series stand: the newest goes back to collecting, the older ones are withdrawn)
update extinguishment_requests e set state = 'withdrawn', decision_code = 'resign-s4-duplicate'
 where e.state = 'built'
   and exists (select 1 from extinguishment_requests o where o.series_id = e.series_id and o.state = 'built' and (o.created_at, o.request_id) > (e.created_at, e.request_id));
update extinguishment_requests set state = 'collecting', decision_code = 'resign-s4'
 where state = 'built';

alter table extinguishment_requests alter column state set default 'collecting';
alter table extinguishment_requests add constraint extinguishment_requests_state_check check (state in ('collecting', 'ready', 'sent', 'withdrawn'));

-- two distinct 20-byte keys
alter table extinguishment_requests drop constraint if exists extinguishment_requests_attestors_check;
alter table extinguishment_requests add constraint extinguishment_requests_attestors_check check (
  cardinality(attestors) = 2 and attestors[1] <> attestors[2]
);

-- the signatures: an array of at most two well-formed entries by distinct named keys, over one nonce; collecting has
-- fewer than two, ready has two, a relayed (`sent`) row has both and its relay transaction (a row sent before S4 WP12
-- has neither)
alter table extinguishment_requests drop constraint if exists extinguishment_requests_signatures_check;
alter table extinguishment_requests add constraint extinguishment_requests_signatures_check check (
  jsonb_typeof(signatures) = 'array'
  and jsonb_array_length(signatures) <= 2
  and jsonb_array_length(jsonb_path_query_array(signatures, '$[*] ? (@.signer like_regex "^0x[0-9a-f]{40}$" && @.signature like_regex "^0x[0-9a-f]{130}$" && @.digest like_regex "^0x[0-9a-f]{64}$")')) = jsonb_array_length(signatures)
  and jsonb_array_length(jsonb_path_query_array(signatures, '$[*] ? (@.signer == $a || @.signer == $b)', jsonb_build_object('a', attestors[1], 'b', attestors[2]))) = jsonb_array_length(signatures)
  and (jsonb_array_length(signatures) < 2 or signatures->0->>'signer' <> signatures->1->>'signer')
  and ((jsonb_array_length(signatures) = 0) = (extinguish_nonce is null))
  and (state <> 'collecting' or jsonb_array_length(signatures) < 2)
  and (state <> 'ready' or jsonb_array_length(signatures) = 2)
  and (relay_tx is null or (state = 'sent' and jsonb_array_length(signatures) = 2))
  and (state <> 'sent' or (relay_tx is null) = (jsonb_array_length(signatures) = 0))
  and (relay_error is null or state = 'ready')
);
-- at most one open request per series: one set of signatures over its nonce at a time
create unique index if not exists extinguishment_requests_open on extinguishment_requests (series_id) where state in ('collecting', 'ready');

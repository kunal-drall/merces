# VECTOR_PARITY.md

Stage 1 parity vectors in $STAGE1_PATH/packages/vectors at 1bfc66b (schema 2, SPEC 1.1), replayed by the Stage 1 vector runner (`packages/stage1-sync/src/stage1-vectors`, `pnpm stage1:vectors`).

Every `expect` compares the keys it carries, each as a whole value; every `expect_revert` must raise the named Stage 1 error and leave the state unchanged; Σ stablecoin equals Σ `fund` after every step, and the unit supply holds at every `expect`. Proofs are verified for real with the ports' `Groth16ReportVerifier` (Stage 1's verifier and development verification key): 164 distinct proofs, 3 invalid (the vectors' deliberate tamper cases).

## Results

| Vector | reference | merces/solana | merces/monad | Expected after S1 (merces) |
| --- | --- | --- | --- | --- |
| 01_happy_path | PASS 67/67 | PASS-WITH-WAIVERS 67/67 | PASS-WITH-WAIVERS 67/67 | PASS-WITH-WAIVERS (#32 NA-1, #34 BLK-1) |
| 02_failed_auction | PASS 38/38 | — | — | NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts (multi-step settlement)) |
| 03_auction_edges | PASS 78/78 | — | — | NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts; the non-reveal charge on b8 (owner hold, not modelled)) |
| 04_zero_quarters | PASS 81/81 | PASS 81/81 | PASS 81/81 | PASS |
| 05_cap_hit | PASS 54/54 | PASS-WITH-WAIVERS 54/54 | PASS-WITH-WAIVERS 54/54 | PASS-WITH-WAIVERS (#42 BLK-1) |
| 06_redemption_terms | PASS 116/116 | PASS 116/116 | PASS 116/116 | PASS |
| 07_late_payment | PASS 59/59 | PASS 59/59 | PASS 59/59 | PASS |
| 08_hardship_pause | PASS 64/64 | — | — | NOT-IN-S1 (S5: withdraw_pause_request and end_pause) |
| 09_tail_clause | PASS 95/95 | PASS 95/95 | PASS 95/95 | PASS |
| 10_transfer_window | PASS 92/92 | — | — | NOT-IN-S1 (S5: multi-step transfer windows) |
| 11_extinguishment | PASS 52/52 | PASS 52/52 | PASS 52/52 | PASS |
| 12_multi_series_router | PASS 118/118 | — | — | NOT-IN-S1 (S5: income router) |
| 13_fx | PASS 281/281 | — | — | NOT-IN-S1 (S5: FX accumulator) |
| 14_amendment | PASS 83/83 | — | — | NOT-IN-S1 (S5: retire_if_capped as an action) |
| 15_zero_valid_bids | PASS 35/35 | — | — | NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts (multi-step settlement)) |
| 16_demand_limited_window | PASS 77/77 | — | — | NOT-IN-S1 (S5: multi-step transfer windows) |
| 17_undelivered_winner | PASS 51/51 | — | — | NOT-IN-S1 (S2: deferred delivery and register_holder) |
| 18_report_before_finalization | PASS 51/51 | — | — | NOT-IN-S1 (S5: income router) |
| 19_pause_while_late | PASS 60/60 | PASS 60/60 | PASS 60/60 | PASS |
| 20_tier3_trueup | PASS 120/120 | — | — | NOT-IN-S1 (S5: tier-3 true-up) |
| 21_entry_rules | PASS 61/61 | — | — | NOT-IN-S1 (S5: withdraw_pause_request) |
| 22_late_holder_tail_final | PASS 111/111 | — | — | NOT-IN-S1 (S3 + S5: register_holder, tail and final claims, multi-step windows) |
| 23_redeem_twice_with_tail | PASS 63/63 | PASS 63/63 | PASS 63/63 | PASS |
| 24_inverted_fx | PASS 94/94 | — | — | NOT-IN-S1 (S5: FX accumulator (inverted pair)) |
| 25_window_on_terminal | PASS 91/91 | PASS 91/91 | PASS 91/91 | PASS |

## Findings

None: every replayed step matched.

## Waived steps

- 01_happy_path #32 `expect_revert transfer_units` on merces/solana: N/A (NA-1), waived
- 01_happy_path #34 `expect_revert retire_if_capped` on merces/solana: BLOCKED (BLK-1), waived
- 01_happy_path #32 `expect_revert transfer_units` on merces/monad: N/A (NA-1), waived
- 01_happy_path #34 `expect_revert retire_if_capped` on merces/monad: BLOCKED (BLK-1), waived
- 05_cap_hit #42 `expect_revert retire_if_capped` on merces/solana: BLOCKED (BLK-1), waived
- 05_cap_hit #42 `expect_revert retire_if_capped` on merces/monad: BLOCKED (BLK-1), waived

## Shims (not parity)

The merces backend runs these Stage 1 ops through canonical calls of another shape (S1 plan §5.3). A step run through a shim is executed and checked, but it is not parity for that op; `blocked` and `n/a` rows are not run at all. The reference backend runs Stage 1's own simulator and uses none of them. "Used in" lists the vectors of this report that went through the row.

| ID | Stage 1 op | Our call | Why it is a shim | Removed in | Used in |
| --- | --- | --- | --- | --- | --- |
| SH-REG-1 | `register_issuer` | registerIssuer signed by that wallet | Stage 1 registers issuers admin-only (STAGE1_INTEGRATION.md B.7) | S5 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-REG-2 | `register_attestor`, `revoke_attestor` | admin registerAttestor{active} | no 45-day revocation grace modelled | S4 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-REG-3 | `register_verifier_key` | registerVerifierKey{keyId: name, ed25519 SPKI from the seed} | Stage 1 verifier keys are secp256k1 | S4 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-REG-4 | `create_series` | createSeries (USDC, USD, sealed; due/grace/notice days from config.parameters; tier bitmask → object; atOffsetSeconds → afterSeconds); commit/reveal/window durations, windowFeeBps and nonRevealChargeBps held by the runner, their Stage 1 bounds unchecked | canonical terms lack those fields | S2, S5 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-1 | `open_raise` | openRaise{commitEndsAt = t + commitDuration, revealEndsAt = + revealDuration} | durations are not canonical terms | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-2 | `commit_bid` | commitBid{commitment recomputed from the plaintext, deposit = escrow} | Stage 1 uses a keccak commitment | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-3 | `begin_settlement` | keeper settleAuction (one step) when Stage 1's tally of the same revealed bids accepts the proposal (claims and isClearingPriceValid), then our price and units checked against it; a proposal Stage 1 rejects is BLOCKED | canonical settlement is one step | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-4 | `finalize_settlement` | no-op; asserts Settled or Failed | canonical settlement is one step | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-5 | `process_bid` | no-op; bookkeeping of processed bids and minted units (the engine's allocation) | canonical settlement mints inside settleAuction | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-AUC-6 | `deliver_bid` | claimRefund when refundable > 0, else nothing; bookkeeping of delivery | push vs pull refunds | S2 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-REP-1 | `submit_report` | submitReport{prior, income, Groth16 proof and signals}; tier-2 attestation signed by the runner with the named key; tier 3 co-signed by the attestor | signatures are S4; proofs are real | S4 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-PAY-1 | `pay` | payIn{periodId: open due period (else the next expected period), amount: the period payment due} | Stage 1's pay has no amount or period | S5 | 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 |
| SH-PAU-1 | `request_pause` | requestPause{until: t + maxPauseSeconds} | Stage 1's request has no end | S5 | 19 |
| SH-PAU-2 | `approve_pause` | approvePause{until: pauseEnd} sent by the attestor wallet | signatures as arguments are S4 | S4 | 19 |
| SH-CLM-1 | `claim` | claimPayout | S1 claimPayout = claim + tail + final | S3 | 01, 04, 05, 07, 19 |
| SH-CLM-2 | `claim_tail` | claimRedemption first when nothing is redeemed yet and units remain (SIM:1409), then claimPayout | no claimTail command | S3 | 09, 23 |
| SH-CLM-3 | `claim_final` | claimPayout | no claimFinal command | S3 | 11 |
| SH-BRN-1 | `burn_retired` | keeper crankBurn{holders: [holder]} | batch shape | — | 05 |
| SH-RED-1 | `redeem` | redeem{maxPricePerUnit: U64_MAX} | Stage 1 has no slippage bound | — | 06, 09, 23, 25 |
| SH-EXT-1 | `extinguish` | extinguish{attestors} sent by attestors[0], attestors[1] co-signing (deduplicated) | co-signing vs signatures | S4 | 11, 25 |
| SH-AMD-1 | `amend_terms` | amendTerms{termsCommitment, capMultipleWad, attestor} with the attestor co-signing | co-signing vs signatures | S4 | — |
| SH-WIN-1 | `open_window` | keeper openTransferWindow{t + windowCommitDuration, + windowRevealDuration}; period kept by the runner | one-step windows | S5 | 23, 25 |
| SH-WIN-2 | `commit_ask` | commitWindowOrder{side: sell, deposit 0, units} | one-step windows | S5 | 23, 25 |
| SH-WIN-3 | `window_commit_bid` | commitWindowOrder{side: buy, deposit: escrow, units 0} | one-step windows | S5 | 25 |
| SH-WIN-4 | `reveal_order` | revealWindowOrder (side from the commit) | one-step windows | S5 | 23, 25 |
| SH-WIN-5 | `begin_window_settlement` | record only, for NO_MATCH or a terminal series; a priced proposal on a live series is BLOCKED | one-step windows | S5 | 23, 25 |
| SH-WIN-6 | `finalize_window` | clearTransferWindow; asserts nothing transferred where Stage 1 settles NoMatch | one-step windows | S5 | 23, 25 |
| SH-WIN-7 | `process_orders` | no-op | one-step windows | S5 | 23, 25 |
| SH-FLG-1 | `config.flags.windowsEnabled` | runner only: open_window on a series with windows disabled is BLOCKED | no canonical windows flag | S5 | — |
| BLK-1 (BLOCKED) | `retire_if_capped` | none: BLOCKED (waived in 01#34, 05#42) | no canonical command | S5 | 01, 05 |
| NA-1 (N/A) | `transfer_units` | none: N/A (01#32) | the canonical model has no transfer to refuse | — | 01 |

Shim-derived view fields (runner bookkeeping, also not parity): `auction.tallyRound`, `roundRejected`, `rejectionReason`, `qAbove`, `qAt`, `R`, `unitsMinted`, `bidsProcessed`, `auctionEscrowUnits`; `holders.*.pendingUnits`, `pendingRefund` (from the engine's `refundable`) and `delivered`; `window.period`, `state`, `tallyRound`, `roundRejected`, `branch` and `matchedUnits`.

## Not replayed on the merces backend in S1

- 02_failed_auction: NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts (multi-step settlement))
- 03_auction_edges: NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts; the non-reveal charge on b8 (owner hold, not modelled))
- 08_hardship_pause: NOT-IN-S1 (S5: withdraw_pause_request and end_pause)
- 10_transfer_window: NOT-IN-S1 (S5: multi-step transfer windows)
- 12_multi_series_router: NOT-IN-S1 (S5: income router)
- 13_fx: NOT-IN-S1 (S5: FX accumulator)
- 14_amendment: NOT-IN-S1 (S5: retire_if_capped as an action)
- 15_zero_valid_bids: NOT-IN-S1 (S2: mid-processing expects and process/finalize reverts (multi-step settlement))
- 16_demand_limited_window: NOT-IN-S1 (S5: multi-step transfer windows)
- 17_undelivered_winner: NOT-IN-S1 (S2: deferred delivery and register_holder)
- 18_report_before_finalization: NOT-IN-S1 (S5: income router)
- 20_tier3_trueup: NOT-IN-S1 (S5: tier-3 true-up)
- 21_entry_rules: NOT-IN-S1 (S5: withdraw_pause_request)
- 22_late_holder_tail_final: NOT-IN-S1 (S3 + S5: register_holder, tail and final claims, multi-step windows)
- 24_inverted_fx: NOT-IN-S1 (S5: FX accumulator (inverted pair))

## Inventory

| Vector | Steps | Expect checks | Expected reverts | Ops the merces backend shims, blocks or lacks in S1 |
| --- | --- | --- | --- | --- |
| 01_happy_path.json | 67 | 10 | 9 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report`, `transfer_units` |
| 02_failed_auction.json | 38 | 4 | 7 | `begin_settlement`, `cancel_raise`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key` |
| 03_auction_edges.json | 78 | 7 | 12 | `begin_settlement`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key` |
| 04_zero_quarters.json | 81 | 7 | 6 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 05_cap_hit.json | 54 | 6 | 4 | `amend_terms`, `begin_settlement`, `burn_retired`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report` |
| 06_redemption_terms.json | 116 | 9 | 5 | `begin_settlement`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 07_late_payment.json | 59 | 10 | 2 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 08_hardship_pause.json | 64 | 7 | 8 | `approve_pause`, `begin_settlement`, `commit_bid`, `create_series`, `deliver_bid`, `end_pause`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report`, `withdraw_pause_request` |
| 09_tail_clause.json | 95 | 7 | 4 | `begin_settlement`, `claim_tail`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 10_transfer_window.json | 92 | 6 | 12 | `begin_settlement`, `begin_window_settlement`, `claim`, `commit_ask`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `open_raise`, `open_window`, `pay`, `process_bid`, `process_orders`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `set_flags`, `submit_report`, `transfer_units`, `window_commit_bid` |
| 11_extinguishment.json | 52 | 4 | 7 | `amend_terms`, `begin_settlement`, `claim_final`, `commit_bid`, `create_series`, `deliver_bid`, `extinguish`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `revoke_attestor`, `submit_report` |
| 12_multi_series_router.json | 118 | 10 | 6 | `begin_settlement`, `claim`, `close_router_period`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `resume_issuance`, `route_income`, `stop_issuance`, `submit_report` |
| 13_fx.json | 281 | 5 | 10 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `fx_snapshot`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `set_fx_pair`, `submit_report` |
| 14_amendment.json | 83 | 6 | 8 | `amend_terms`, `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report` |
| 15_zero_valid_bids.json | 35 | 4 | 7 | `begin_settlement`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 16_demand_limited_window.json | 77 | 6 | 0 | `begin_settlement`, `begin_window_settlement`, `claim`, `commit_ask`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `open_raise`, `open_window`, `pay`, `process_bid`, `process_orders`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `set_flags`, `submit_report`, `window_commit_bid` |
| 17_undelivered_winner.json | 51 | 4 | 4 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_holder`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 18_report_before_finalization.json | 51 | 6 | 5 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `route_income`, `submit_report` |
| 19_pause_while_late.json | 60 | 8 | 4 | `approve_pause`, `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report` |
| 20_tier3_trueup.json | 120 | 11 | 12 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `pay_trueup`, `process_bid`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report`, `submit_trueup` |
| 21_entry_rules.json | 61 | 5 | 10 | `approve_pause`, `begin_settlement`, `burn_retired`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report`, `withdraw_pause_request` |
| 22_late_holder_tail_final.json | 111 | 6 | 1 | `begin_settlement`, `begin_window_settlement`, `claim_final`, `claim_tail`, `commit_ask`, `commit_bid`, `create_series`, `deliver_bid`, `extinguish`, `finalize_settlement`, `finalize_window`, `open_raise`, `open_window`, `pay`, `process_bid`, `process_orders`, `redeem`, `register_attestor`, `register_holder`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report`, `window_commit_bid` |
| 23_redeem_twice_with_tail.json | 63 | 2 | 0 | `begin_settlement`, `begin_window_settlement`, `claim_tail`, `commit_ask`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `open_raise`, `open_window`, `pay`, `process_bid`, `process_orders`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report` |
| 24_inverted_fx.json | 94 | 2 | 0 | `begin_settlement`, `claim`, `commit_bid`, `create_series`, `deliver_bid`, `finalize_settlement`, `fx_snapshot`, `open_raise`, `pay`, `process_bid`, `register_attestor`, `register_issuer`, `register_verifier_key`, `set_fx_pair`, `submit_report` |
| 25_window_on_terminal.json | 91 | 2 | 0 | `begin_settlement`, `begin_window_settlement`, `commit_ask`, `commit_bid`, `create_series`, `deliver_bid`, `extinguish`, `finalize_settlement`, `finalize_window`, `open_raise`, `open_window`, `pay`, `process_bid`, `process_orders`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report`, `window_commit_bid` |

### Ops used and how they run on the merces backend in S1

| Op | Uses | Canonical | Kind |
| --- | --- | --- | --- |
| `fx_snapshot` | 282 | snapshotRate | not in S1 (S5) |
| `submit_report` | 173 | submitReport (Groth16 proof; attestation signed by the runner) | shim (SH-REP-1) |
| `expect` | 154 | runner assertion | harness |
| `commit_bid` | 151 | commitBid (our commitment recomputed from the plaintext) | shim (SH-AUC-2) |
| `deliver_bid` | 149 | claimRefund for losers; none for winners | shim (SH-AUC-6) |
| `process_bid` | 147 | none (canonical settlement mints inside settleAuction) | shim (SH-AUC-5) |
| `reveal_bid` | 145 | revealBid | direct |
| `expect_revert` | 143 | runner assertion (canonical error names) | harness |
| `fund` | 136 | simulator fund (test faucet) | harness |
| `pay` | 87 | payIn (period and amount supplied by the runner) | shim (SH-PAY-1) |
| `claim` | 81 | claimPayout | shim (SH-CLM-1) |
| `register_attestor` | 51 | registerAttestor | shim (SH-REG-2) |
| `begin_settlement` | 42 | settleAuction (one step; Stage 1 is proposer claims + paged tally + finalize) | shim (SH-AUC-3) |
| `claim_release` | 41 | drawRelease | direct |
| `create_series` | 41 | createSeries (durations, window fee and non-reveal bps held by the runner) | shim (SH-REG-4) |
| `finalize_settlement` | 39 | none (settled inside settleAuction) | shim (SH-AUC-4) |
| `open_raise` | 38 | openRaise with the runner-held durations | shim (SH-AUC-1) |
| `allowlist` | 27 | setAllowlist | direct |
| `register_issuer` | 25 | registerIssuer signed by the wallet (Stage 1: admin-only) | shim (SH-REG-1) |
| `register_verifier_key` | 25 | registerVerifierKey (ed25519; Stage 1: secp256k1) | shim (SH-REG-3) |
| `claim_redemption` | 21 | claimRedemption | direct |
| `reveal_order` | 20 | revealWindowOrder | shim (SH-WIN-4) |
| `redeem` | 17 | redeem (no slippage bound) | shim (SH-RED-1) |
| `claim_tail` | 16 | none (claimRedemption if needed, then claimPayout) | shim (SH-CLM-2) |
| `crank_status` | 15 | crankStatus | direct |
| `begin_window_settlement` | 14 | none (recorded; clearTransferWindow is one step) | shim (SH-WIN-5) |
| `commit_ask` | 13 | commitWindowOrder(side=sell) | shim (SH-WIN-2) |
| `finalize_window` | 13 | clearTransferWindow | shim (SH-WIN-6) |
| `open_window` | 12 | openTransferWindow (period kept by the runner) | shim (SH-WIN-1) |
| `route_income` | 11 | postSplitReceipt | not in S1 (S5) |
| `submit_trueup` | 11 | none (tier-3 true-up) | not in S1 (S5) |
| `window_commit_bid` | 11 | commitWindowOrder(side=buy) | shim (SH-WIN-3) |
| `approve_pause` | 10 | approvePause sent by the attestor wallet | shim (SH-PAU-2) |
| `amend_terms` | 9 | amendTerms with a co-signing attestor | shim (SH-AMD-1) |
| `claim_final` | 9 | none (claimPayout) | shim (SH-CLM-3) |
| `process_orders` | 9 | none (canonical clearing delivers inside clearTransferWindow) | shim (SH-WIN-7) |
| `extinguish` | 6 | extinguish with a co-signing attestor | shim (SH-EXT-1) |
| `request_pause` | 6 | requestPause (until supplied by the runner) | shim (SH-PAU-1) |
| `burn_retired` | 5 | crankBurn | shim (SH-BRN-1) |
| `retire_if_capped` | 5 | none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment) | blocked (BLK-1) |
| `close_router_period` | 3 | none | not in S1 (S5) |
| `end_pause` | 3 | none (crankPause ends a pause at its end only) | not in S1 (S5) |
| `pay_trueup` | 3 | none (tier-3 true-up) | not in S1 (S5) |
| `set_fx_pair` | 3 | none (admin FX pair configuration) | not in S1 (S5) |
| `withdraw_pause_request` | 3 | none | not in S1 (S5) |
| `register_holder` | 2 | none (canonical holders are implicit in positions) | not in S1 (S3) |
| `set_flags` | 2 | pauseNewRaises (Stage 1 also has windows_enabled) | not in S1 (S5) |
| `transfer_units` | 2 | none: a direct unit transfer, used only inside expect_revert (DirectTransferForbidden); the canonical model has no transfer to refuse | n/a (NA-1) |
| `cancel_raise` | 1 | cancelRaise | not in S1 (S2) |
| `resume_issuance` | 1 | none | not in S1 (S5) |
| `revoke_attestor` | 1 | registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace) | shim (SH-REG-2) |
| `stop_issuance` | 1 | stopIssuance | not in S1 (S5) |

### Expect fields

- `auction` × 154
- `auctionEscrow` × 154
- `balances` × 154
- `feeCollector` × 154
- `holders` × 154
- `ledger` × 154
- `series` × 154
- `treasury` × 154
- `vault` × 154
- `window` × 21
- `windowEscrowStable` × 21
- `windowEscrowUnits` × 21
- `routerBalance` × 15
- `fx` × 6

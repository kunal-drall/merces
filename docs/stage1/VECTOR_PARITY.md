# VECTOR_PARITY.md

Stage 1 parity vectors in $STAGE1_PATH/packages/vectors at 1bfc66b (schema 2, SPEC 1.1), replayed by the Stage 1 vector runner (`packages/stage1-sync/src/stage1-vectors`, `pnpm stage1:vectors`).

Every `expect` compares the keys it carries, each as a whole value; every `expect_revert` must raise the named Stage 1 error, the transaction that raised must leave the state and the event log unchanged (checked before the merces backend restores anything), and the world must then be as it was before the call; Σ stablecoin equals Σ `fund` after every step, and the unit supply holds at every `expect`. Proofs are verified for real with the ports' `Groth16ReportVerifier` (Stage 1's verifier and development verification key): 164 distinct proofs, 3 invalid (the vectors' deliberate tamper cases).

## Results

| Vector | reference | merces/solana | merces/monad | Expected after S3 (merces) |
| --- | --- | --- | --- | --- |
| 01_happy_path | PASS 67/67 | PASS-WITH-WAIVERS 67/67 | PASS-WITH-WAIVERS 67/67 | PASS-WITH-WAIVERS (#32 NA-1, #34 BLK-1) |
| 02_failed_auction | PASS 38/38 | PASS 38/38 | PASS 38/38 | PASS |
| 03_auction_edges | PASS 78/78 | PASS-WITH-DIVERGENCES (5 accepted divergences) 78/78 | PASS-WITH-DIVERGENCES (5 accepted divergences) 78/78 | PASS-WITH-DIVERGENCES (DIV-NRC-1: 5 field(s) at #67, #77; lockstep parts at #65) |
| 04_zero_quarters | PASS 81/81 | PASS 81/81 | PASS 81/81 | PASS |
| 05_cap_hit | PASS 54/54 | PASS-WITH-WAIVERS 54/54 | PASS-WITH-WAIVERS 54/54 | PASS-WITH-WAIVERS (#42 BLK-1) |
| 06_redemption_terms | PASS 116/116 | PASS 116/116 | PASS 116/116 | PASS |
| 07_late_payment | PASS 59/59 | PASS 59/59 | PASS 59/59 | PASS |
| 08_hardship_pause | PASS 64/64 | PASS 34/64, stopped at #34 (until) | PASS 34/64, stopped at #34 (until) | PREFIX-PASS to #33, then NOT-YET (S5: withdraw_pause_request and end_pause) |
| 09_tail_clause | PASS 95/95 | PASS 95/95 | PASS 95/95 | PASS |
| 10_transfer_window | PASS 92/92 | PASS 36/92, stopped at #36 (until) | PASS 36/92, stopped at #36 (until) | PREFIX-PASS to #35, then NOT-YET (S5: multi-step transfer windows) |
| 11_extinguishment | PASS 52/52 | PASS 52/52 | PASS 52/52 | PASS |
| 12_multi_series_router | PASS 118/118 | — | — | NOT-YET (S5: income router) |
| 13_fx | PASS 281/281 | — | — | NOT-YET (S5: FX accumulator) |
| 14_amendment | PASS 83/83 | PASS 62/83, stopped at #62 (until) | PASS 62/83, stopped at #62 (until) | PREFIX-PASS to #61, then NOT-YET (S5: retire_if_capped as an action) |
| 15_zero_valid_bids | PASS 35/35 | PASS 35/35 | PASS 35/35 | PASS |
| 16_demand_limited_window | PASS 77/77 | PASS 41/77, stopped at #41 (until) | PASS 41/77, stopped at #41 (until) | PREFIX-PASS to #40, then NOT-YET (S5: multi-step transfer windows) |
| 17_undelivered_winner | PASS 51/51 | PASS 51/51 | PASS 51/51 | PASS |
| 18_report_before_finalization | PASS 51/51 | — | — | NOT-YET (S5: income router (stops at #11, create_series with a router)) |
| 19_pause_while_late | PASS 60/60 | PASS 60/60 | PASS 60/60 | PASS |
| 20_tier3_trueup | PASS 120/120 | PASS 71/120, stopped at #71 (until) | PASS 71/120, stopped at #71 (until) | PREFIX-PASS to #70, then NOT-YET (S5: tier-3 true-up) |
| 21_entry_rules | PASS 61/61 | PASS 41/61, stopped at #41 (until) | PASS 41/61, stopped at #41 (until) | PREFIX-PASS to #40, then NOT-YET (S5: withdraw_pause_request; u64 pause ends) |
| 22_late_holder_tail_final | PASS 111/111 | PASS 76/111, stopped at #76 (until) | PASS 76/111, stopped at #76 (until) | PREFIX-PASS to #75, then NOT-YET (S5: multi-step windows (#76); its claim steps #88-#110 run once windows land) |
| 23_redeem_twice_with_tail | PASS 63/63 | PASS 63/63 | PASS 63/63 | PASS |
| 24_inverted_fx | PASS 94/94 | — | — | NOT-YET (S5: FX accumulator (inverted pair)) |
| 25_window_on_terminal | PASS 91/91 | PASS 91/91 | PASS 91/91 | PASS |

## Findings

None: every replayed step matched, the known divergences below aside.

## Known divergences (not parity)

Stage 1 behaviour the merces backend knowingly does not mirror (the register, `stage1-vectors/divergences.ts`). Each is recorded per `expect` step and field with Stage 1's value and ours (`expected.ts`): a difference equal to a recorded entry is accepted and the run is PASS-WITH-DIVERGENCES; another value at that field fails, and an entry whose difference no longer occurs fails as stale. In lockstep the backends must part right after the recorded step on exactly the recorded fields; the replay stops there.

### DIV-NRC-1: the non-reveal charge (owner hold)

- What: Stage 1 keeps floor(escrow × nonRevealChargeBps / 10000) of a bid committed and never revealed when the raise settles, and pays it to the fee collector at `process_bid` (SPEC §5.2; REF `processBid`, the unrevealed branch; SIM `processBid`); the bid's refund is the escrow less the charge. On a failed raise nothing is charged. The merces backend records the series' rate but applies 0 bps (`appliedNonRevealChargeBps`), so the bid is refunded in full and the fee collector receives nothing for it.
- Why: owner hold (S2 amendment M1): the owner asked to be told what Stage 1 does before the charge is modelled. `NON_REVEAL_CHARGE_HELD` (packages/domain/src/params.ts) is the one switch; the engine refuses any non-zero charge while it is on (ASSUMPTIONS.md A-AUC-11).
- Seen: only vector 03 (S1/b8, escrow 10,100 USDC, charged 101 USDC at 1%): the expects at #67 (feeCollector, auctionEscrow, auction.escrowTotal) and #77 (balances.b8.stable, feeCollector); lockstep parts at #65 (`process_bid b8`). The other unrevealed bids (02 S2/b1, 15 S1/b3) are on failed raises, where Stage 1 charges nothing.
- Until: after the owner decides
- Lifting it: set `NON_REVEAL_CHARGE_HELD` to false and add what the charge needs (the `NonRevealCharged` event, a `nonReveal` fee kind, the bids' charge column, accounting and API fields; STAGE1_INTEGRATION.md divergence register); delete the DIV-NRC-1 entries and the lockstep expectation of vector 03 in `expected.ts` and set 03 to PASS (until then the runner fails 03 on five stale entries); regenerate VECTOR_PARITY.md and update A-AUC-11.

| Vector | Step | Field | Stage 1 | Ours |
| --- | --- | --- | --- | --- |
| 03_auction_edges | #67 | `auction.escrowTotal` | "55925700000" | "56026700000" |
| 03_auction_edges | #67 | `auctionEscrow` | "55925700000" | "56026700000" |
| 03_auction_edges | #67 | `feeCollector` | "428800000" | "327800000" |
| 03_auction_edges | #77 | `balances.b8.stable` | "29899000000" | "30000000000" |
| 03_auction_edges | #77 | `feeCollector` | "428800000" | "327800000" |
| 03_auction_edges (lockstep) | after #65 | `S1.auction.escrowTotal` | "55925700000" | "56026700000" |
| 03_auction_edges (lockstep) | after #65 | `S1.auctionEscrow` | "55925700000" | "56026700000" |
| 03_auction_edges (lockstep) | after #65 | `S1.feeCollector` | "428800000" | "327800000" |

- 03_auction_edges on merces/solana: #67 (3 fields), #77 (2 fields), as recorded
- 03_auction_edges on merces/monad: #67 (3 fields), #77 (2 fields), as recorded

## Prefix gates

A vector that needs a later milestone is replayed on the merces backend up to its gate, the last step before the first one the merces backend cannot run yet; every step up to the gate must pass (PREFIX-PASS), so the auction prefix and everything else before the gate stays protected. Gates measured on S2 and again on S3 WP2, unchanged: a full replay's first finding is the step after each gate, on both personalities and in lockstep.

| Vector | Replayed to | Next step | The whole vector |
| --- | --- | --- | --- |
| 08_hardship_pause | #33 | #34 `withdraw_pause_request` (no canonical command) | S5: withdraw_pause_request and end_pause |
| 10_transfer_window | #35 | #36 `expect_revert open_window` with windows disabled (no canonical windows flag to refuse with) | S5: multi-step transfer windows |
| 14_amendment | #61 | #62 `expect_revert retire_if_capped` (no canonical command) | S5: retire_if_capped as an action |
| 16_demand_limited_window | #40 | #41 `set_flags` (no canonical windows flag) | S5: multi-step transfer windows |
| 20_tier3_trueup | #70 | #71 `expect_revert submit_trueup` (no tier-3 true-up) | S5: tier-3 true-up |
| 21_entry_rules | #40 | #41 `expect_revert approve_pause` with a pause end of 2^64 (the canonical pause end is a safe integer, so it is not AmountOutOfRange), then #42 `withdraw_pause_request` | S5: withdraw_pause_request; u64 pause ends |
| 22_late_holder_tail_final | #75 | #76 `begin_window_settlement` with a price on a live series (one-step windows) | S5: multi-step windows (#76); its claim steps #88-#110 run once windows land |

## Waived steps

- 01_happy_path #32 `expect_revert transfer_units` on merces/solana: N/A (NA-1), waived
- 01_happy_path #34 `expect_revert retire_if_capped` on merces/solana: BLOCKED (BLK-1), waived
- 01_happy_path #32 `expect_revert transfer_units` on merces/monad: N/A (NA-1), waived
- 01_happy_path #34 `expect_revert retire_if_capped` on merces/monad: BLOCKED (BLK-1), waived
- 05_cap_hit #42 `expect_revert retire_if_capped` on merces/solana: BLOCKED (BLK-1), waived
- 05_cap_hit #42 `expect_revert retire_if_capped` on merces/monad: BLOCKED (BLK-1), waived

## Runner-atomic reverts

Expected reverts of a call the merces backend carries out as several transactions, where some went through before one raised the expected error: the runner undid them, so the call reverted as a whole by the runner's doing, not the engine's (not parity).

None: every expected revert raised in the call's first transaction.

## Shims (not parity)

The merces backend runs these Stage 1 ops through canonical calls of another shape (S1 plan §5.3). A step run through a shim is executed and checked, but it is not parity for that op; `blocked` and `n/a` rows are not run at all. A runner-atomic row may send several transactions for one Stage 1 call, and the runner undoes the ones that went through when a later one reverts. The reference backend runs Stage 1's own simulator and uses none of them. "Used in" lists the vectors of this report that went through the row, the calls of `expect_revert` steps included.

| ID | Stage 1 op | Our call | Why it is a shim | Removed in | Used in |
| --- | --- | --- | --- | --- | --- |
| SH-REG-1 | `register_issuer` | registerIssuer signed by that wallet | Stage 1 registers issuers admin-only (STAGE1_INTEGRATION.md B.7) | S5 | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-REG-2 | `register_attestor`, `revoke_attestor` | admin registerAttestor{active} | no 45-day revocation grace modelled | S4 | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-REG-3 | `register_verifier_key` | registerVerifierKey{keyId: name, ed25519 SPKI from the seed} | Stage 1 verifier keys are secp256k1 | S4 | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-REG-4 | `create_series` | createSeries (USDC, USD, sealed; due/grace/notice days from config.parameters; tier bitmask → object; atOffsetSeconds → afterSeconds); window durations and windowFeeBps held by the runner, their Stage 1 bounds unchecked | canonical terms lack those fields | S5 | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-AUC-2 | `commit_bid` | commitBid{commitment recomputed from the plaintext by our builder, which decodes the price and quantity as u64s (AmountOutOfRange), deposit = escrow} | Stage 1 uses a keccak commitment | S4 | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-REP-1 | `submit_report` | submitReport{prior, income, Groth16 proof and signals}; tier-2 attestation signed by the runner with the named key; tier 3 co-signed by the attestor | signatures are S4; proofs are real | S4 | 01, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 16, 17, 19, 20, 22, 23, 25 |
| SH-PAY-1 | `pay` | payIn{periodId: open due period (else the next expected period), amount: the period payment due} | Stage 1's pay has no amount or period | S5 | 01, 04, 05, 06, 07, 09, 10, 11, 14, 16, 17, 19, 20, 21, 22, 23, 25 |
| SH-PAU-1 | `request_pause` | requestPause{until: t + maxPauseSeconds} | Stage 1's request has no end | S5 | 08, 19, 21 |
| SH-PAU-2 | `approve_pause` | approvePause{until: pauseEnd} sent by the attestor wallet | signatures as arguments are S4 | S4 | 08, 19 |
| SH-CLM-1 | `claim` | claimPayout | S1 claimPayout = claim + tail + final | S3 | 01, 04, 05, 07, 17, 19, 21 |
| SH-RED-1 | `redeem` | redeem{maxPricePerUnit: U64_MAX} | Stage 1 has no slippage bound | — | 01, 05, 06, 09, 11, 23, 25 |
| SH-EXT-1 | `extinguish` | extinguish{attestors} sent by attestors[0], attestors[1] co-signing (deduplicated) | co-signing vs signatures | S4 | 11, 25 |
| SH-AMD-1 | `amend_terms` | amendTerms{termsCommitment, capMultipleWad, attestor} with the attestor co-signing | co-signing vs signatures | S4 | 05, 11, 14 |
| SH-WIN-1 | `open_window` | keeper openTransferWindow{t + windowCommitDuration, + windowRevealDuration}; period kept by the runner | one-step windows | S5 | 22, 23, 25 |
| SH-WIN-2 | `commit_ask` | commitWindowOrder{side: sell, deposit 0, units} | one-step windows | S5 | 22, 23, 25 |
| SH-WIN-3 | `window_commit_bid` | commitWindowOrder{side: buy, deposit: escrow, units 0} | one-step windows | S5 | 22, 25 |
| SH-WIN-4 | `reveal_order` | revealWindowOrder (side from the commit) | one-step windows | S5 | 22, 23, 25 |
| SH-WIN-5 | `begin_window_settlement` | record only, for NO_MATCH or a terminal series; a priced proposal on a live series is BLOCKED | one-step windows | S5 | 23, 25 |
| SH-WIN-6 | `finalize_window` | clearTransferWindow; asserts nothing transferred where Stage 1 settles NoMatch | one-step windows | S5 | 23, 25 |
| SH-WIN-7 | `process_orders` | no-op | one-step windows | S5 | 23, 25 |
| SH-FLG-1 | `config.flags.windowsEnabled` | runner only: open_window on a series with windows disabled is BLOCKED | no canonical windows flag | S5 | — |
| BLK-1 (BLOCKED) | `retire_if_capped` | none: BLOCKED (waived in 01#34, 05#42) | no canonical command | S5 | 01, 05 |
| NA-1 (N/A) | `transfer_units` | none: N/A (01#32) | the canonical model has no transfer to refuse | — | 01 |

Shim-derived view fields (runner bookkeeping, also not parity): `window.period`, `state`, `tallyRound`, `roundRejected`, `branch` and `matchedUnits`. Every auction and holder field comes from the engine (S2).

## Not replayed on the merces backend

- 12_multi_series_router: NOT-YET (S5: income router)
- 13_fx: NOT-YET (S5: FX accumulator)
- 18_report_before_finalization: NOT-YET (S5: income router (stops at #11, create_series with a router))
- 24_inverted_fx: NOT-YET (S5: FX accumulator (inverted pair))

## S3 claim scenarios (ours, lockstep against Stage 1's Simulator)

The paths of Stage 1's claim family that no Stage 1 vector takes (S3 plan WP2, amendment M5), written in Stage 1's op format (`packages/stage1-sync/test/fixtures/s3-claims`, `pnpm stage1:vectors --scenarios`). Each reuses steps of a Stage 1 vector (its bootstrap, raise, reports with their proofs and payments) and adds calls of our own; its own `expect`s carry Stage 1's values, which the reference backend (Stage 1's simulator) passes, and lockstep compares the full snapshots of both backends after every step. They are ours, not Stage 1's vectors: every backend must PASS them, with no waiver and no divergence.

| Scenario | Covers | Built from | reference | merces/solana | merces/monad | lockstep/solana | lockstep/monad |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S3a_tail_before_redeem | (a) | 09 #0-#63 as #0-#63; ours as #64-#66 | PASS 67/67 | PASS 67/67 | PASS 67/67 | PASS 67/67 | PASS 67/67 |
| S3b_tail_not_registered | (b) | 09 #0-#64 as #0-#64; ours as #65-#66; 09 #65-#81 as #67-#83; ours as #84; 09 #82-#94 as #85-#97 | PASS 98/98 | PASS 98/98 | PASS 98/98 | PASS 98/98 | PASS 98/98 |
| S3c_late_register_no_redeemed_units | (c) | 09 #0-#81 as #0-#81; ours as #82-#83; 09 #82-#85 as #84-#87; ours as #88-#89; 09 #87-#93 as #90-#96 | PASS 97/97 | PASS 97/97 | PASS 97/97 | PASS 97/97 | PASS 97/97 |
| S3d_tail_twice | (d) | 09 #0-#64 as #0-#64; ours as #65-#67; 09 #65-#86 as #68-#89; ours as #90-#92; 09 #87-#94 as #93-#100 | PASS 101/101 | PASS 101/101 | PASS 101/101 | PASS 101/101 | PASS 101/101 |
| S3e_final_before_and_after_extinguish | (e) | 11 #0-#38 as #0-#38; ours as #39; 11 #39-#47 as #40-#48; ours as #49-#53; 11 #48-#51 as #54-#57 | PASS 58/58 | PASS 58/58 | PASS 58/58 | PASS 58/58 | PASS 58/58 |
| S3f_final_after_redemption | (f) | 22 #0-#70 as #0-#70; ours as #71-#81 | PASS 82/82 | PASS 82/82 | PASS 82/82 | PASS 82/82 | PASS 82/82 |
| S3g_burn_retired | (g) | 05 #0-#36 as #0-#36; ours as #37; 05 #37-#41 as #38-#42; 05 #43-#46 as #43-#46; ours as #47-#52; 05 #48-#53 as #53-#58 | PASS 59/59 | PASS 59/59 | PASS 59/59 | PASS 59/59 | PASS 59/59 |

- S3a_tail_before_redeem: claim_tail before any redemption is NotRedeemed, for a holder and for a stranger alike: Stage 1 checks the redemption before the registration (SIM:1405-1407), so the stranger is not told HolderNotRegistered. Built on 09's prefix to its last report before S1 redeems (#63).
- S3b_tail_not_registered: After S1 redeems (09 #64), claim_tail by a wallet that is not a registered holder is HolderNotRegistered, before the tail is funded and after (09 #80): a stranger, and the issuer, which is allowlisted but never registered (allowlist membership is not registration). The rest of 09 then runs to its end unchanged.
- S3c_late_register_no_redeemed_units: A late register_holder on a redeemed series whose tail is funded (09 after #81), then claim_tail: NoRedeemedUnits. The issuer is allowlisted, registers permissionlessly with its cursors seeded to 0 and holds nothing, so there is nothing to redeem first and no tail is owed: the funded tail is not misattributed to it (the 22 #97-#98 pattern on another vector). The holders then claim their tails as in 09.
- S3d_tail_twice: claim_tail twice, before and after the tail is funded. b1 claims right after S1 redeems (09 #64): it redeems first (P_redeem x 100 and its pending payout) and the tail is 0; a second claim pays 0; its claim_redemption (09 #65) then redeems 0 units. Once the tail is funded (09 #80) b1's claim (09 #83) pays its whole slice from its cursor 0, and a third claim pays 0, as does b4's second claim after its redeem-first claim (09 #82). 09's own expects hold throughout.
- S3e_final_before_and_after_extinguish: On 11 (extinguished at 11 #39 with half the treasury unvested): claim_final before the extinguishment is TerminalStatus. After it, b1's claim (11 #46) pays its pending payout and its share weighed on its 100 accrual units; a second claim pays 0 and burns nothing; a stranger's claim is HolderNotRegistered; burn_retired is TerminalStatus (the series is Extinguished, not Retired); claim_tail is NotRedeemed (it never redeemed). The other holders then claim as in 11.
- S3f_final_after_redemption: On 22's prefix to #70, S2 (back-loaded releases: its 4th tranche vests in January 2028) redeems; claim_final before the extinguishment is TerminalStatus (Redeemed is not Extinguished); b1 claims its redemption; S2 is extinguished, so the unvested 10,500 USDC becomes the final pool over the 400 units at redemption. claim_final weighs every holder on its redeemed units: b1 (redeemed before) is paid its share only, b2 (unredeemed) is redeemed first at P_redeem and weighed on the 100 units it just redeemed, b3 runs claim_tail first (an extinguished series that redeemed still runs it: redeem first, tail 0) and then its claim_final pays the share and burns nothing; a second claim pays 0. b4 never claims: its units and its share stay.
- S3g_burn_retired: burn_retired on 05: on a live series it is TerminalStatus; once S1 is Retired (05 #39) and b1 and b2 have claimed (05 #45-#46), a wallet that never held units gets a zero burn with no registration check, a holder's units burn while its pending payout stays claimable (05 #49), a repeat and a holder whose claim already burned its units are zero burns. On the Retired series claim_tail is NotRedeemed and claim_final TerminalStatus. 05 then runs to its end. 05 #42 (expect_revert retire_if_capped, BLK-1) is left out: no canonical command until S5, and the scenario does not need it.

## Inventory

| Vector | Steps | Expect checks | Expected reverts | Ops the merces backend shims, blocks or lacks |
| --- | --- | --- | --- | --- |
| 01_happy_path.json | 67 | 10 | 9 | `claim`, `commit_bid`, `create_series`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report`, `transfer_units` |
| 02_failed_auction.json | 38 | 4 | 7 | `commit_bid`, `create_series`, `register_attestor`, `register_issuer`, `register_verifier_key` |
| 03_auction_edges.json | 78 | 7 | 12 | `commit_bid`, `create_series`, `register_attestor`, `register_issuer`, `register_verifier_key` |
| 04_zero_quarters.json | 81 | 7 | 6 | `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 05_cap_hit.json | 54 | 6 | 4 | `amend_terms`, `claim`, `commit_bid`, `create_series`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report` |
| 06_redemption_terms.json | 116 | 9 | 5 | `commit_bid`, `create_series`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 07_late_payment.json | 59 | 10 | 2 | `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 08_hardship_pause.json | 64 | 7 | 8 | `approve_pause`, `commit_bid`, `create_series`, `end_pause`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report`, `withdraw_pause_request` |
| 09_tail_clause.json | 95 | 7 | 4 | `commit_bid`, `create_series`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 10_transfer_window.json | 92 | 6 | 12 | `begin_window_settlement`, `claim`, `commit_ask`, `commit_bid`, `create_series`, `finalize_window`, `open_window`, `pay`, `process_orders`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `set_flags`, `submit_report`, `transfer_units`, `window_commit_bid` |
| 11_extinguishment.json | 52 | 4 | 7 | `amend_terms`, `commit_bid`, `create_series`, `extinguish`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `revoke_attestor`, `submit_report` |
| 12_multi_series_router.json | 118 | 10 | 6 | `claim`, `close_router_period`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `resume_issuance`, `route_income`, `stop_issuance`, `submit_report` |
| 13_fx.json | 281 | 5 | 10 | `claim`, `commit_bid`, `create_series`, `fx_snapshot`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `set_fx_pair`, `submit_report` |
| 14_amendment.json | 83 | 6 | 8 | `amend_terms`, `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `submit_report` |
| 15_zero_valid_bids.json | 35 | 4 | 7 | `commit_bid`, `create_series`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 16_demand_limited_window.json | 77 | 6 | 0 | `begin_window_settlement`, `claim`, `commit_ask`, `commit_bid`, `create_series`, `finalize_window`, `open_window`, `pay`, `process_orders`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `set_flags`, `submit_report`, `window_commit_bid` |
| 17_undelivered_winner.json | 51 | 4 | 4 | `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report` |
| 18_report_before_finalization.json | 51 | 6 | 5 | `claim`, `commit_bid`, `create_series`, `pay`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `retire_if_capped`, `route_income`, `submit_report` |
| 19_pause_while_late.json | 60 | 8 | 4 | `approve_pause`, `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report` |
| 20_tier3_trueup.json | 120 | 11 | 12 | `claim`, `commit_bid`, `create_series`, `pay`, `pay_trueup`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `submit_report`, `submit_trueup` |
| 21_entry_rules.json | 61 | 5 | 10 | `approve_pause`, `claim`, `commit_bid`, `create_series`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `request_pause`, `submit_report`, `withdraw_pause_request` |
| 22_late_holder_tail_final.json | 111 | 6 | 1 | `begin_window_settlement`, `commit_ask`, `commit_bid`, `create_series`, `extinguish`, `finalize_window`, `open_window`, `pay`, `process_orders`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report`, `window_commit_bid` |
| 23_redeem_twice_with_tail.json | 63 | 2 | 0 | `begin_window_settlement`, `commit_ask`, `commit_bid`, `create_series`, `finalize_window`, `open_window`, `pay`, `process_orders`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report` |
| 24_inverted_fx.json | 94 | 2 | 0 | `claim`, `commit_bid`, `create_series`, `fx_snapshot`, `pay`, `register_attestor`, `register_issuer`, `register_verifier_key`, `set_fx_pair`, `submit_report` |
| 25_window_on_terminal.json | 91 | 2 | 0 | `begin_window_settlement`, `commit_ask`, `commit_bid`, `create_series`, `extinguish`, `finalize_window`, `open_window`, `pay`, `process_orders`, `redeem`, `register_attestor`, `register_issuer`, `register_verifier_key`, `reveal_order`, `submit_report`, `window_commit_bid` |

### Ops used and how they run on the merces backend

| Op | Uses | Canonical | Kind |
| --- | --- | --- | --- |
| `fx_snapshot` | 282 | snapshotRate | not yet (S5) |
| `submit_report` | 173 | submitReport (Groth16 proof; attestation signed by the runner) | shim (SH-REP-1) |
| `expect` | 154 | runner assertion | harness |
| `commit_bid` | 151 | commitBid (our commitment recomputed from the plaintext; u64 price and quantity) | shim (SH-AUC-2) |
| `deliver_bid` | 149 | deliverBid | direct |
| `process_bid` | 147 | processBid | direct |
| `reveal_bid` | 145 | revealBid | direct |
| `expect_revert` | 143 | runner assertion (canonical error names) | harness |
| `fund` | 136 | simulator fund (test faucet) | harness |
| `pay` | 87 | payIn (period and amount supplied by the runner) | shim (SH-PAY-1) |
| `claim` | 81 | claimPayout | shim (SH-CLM-1) |
| `register_attestor` | 51 | registerAttestor | shim (SH-REG-2) |
| `begin_settlement` | 42 | beginSettlement (permissionless; sent by the keeper) | direct |
| `claim_release` | 41 | drawRelease | direct |
| `create_series` | 41 | createSeries (window durations and fee held by the runner) | shim (SH-REG-4) |
| `finalize_settlement` | 39 | tallyBids (every page) then finalizeSettlement | direct |
| `open_raise` | 38 | openRaise (the phase ends from the series durations) | direct |
| `allowlist` | 27 | setAllowlist | direct |
| `register_issuer` | 25 | registerIssuer signed by the wallet (Stage 1: admin-only) | shim (SH-REG-1) |
| `register_verifier_key` | 25 | registerVerifierKey (ed25519; Stage 1: secp256k1) | shim (SH-REG-3) |
| `claim_redemption` | 21 | claimRedemption | direct |
| `reveal_order` | 20 | revealWindowOrder | shim (SH-WIN-4) |
| `redeem` | 17 | redeem (no slippage bound) | shim (SH-RED-1) |
| `claim_tail` | 16 | claimTail | direct |
| `crank_status` | 15 | crankStatus | direct |
| `begin_window_settlement` | 14 | none (recorded; clearTransferWindow is one step) | shim (SH-WIN-5) |
| `commit_ask` | 13 | commitWindowOrder(side=sell) | shim (SH-WIN-2) |
| `finalize_window` | 13 | clearTransferWindow | shim (SH-WIN-6) |
| `open_window` | 12 | openTransferWindow (period kept by the runner) | shim (SH-WIN-1) |
| `route_income` | 11 | postSplitReceipt | not yet (S5) |
| `submit_trueup` | 11 | none (tier-3 true-up) | not yet (S5) |
| `window_commit_bid` | 11 | commitWindowOrder(side=buy) | shim (SH-WIN-3) |
| `approve_pause` | 10 | approvePause sent by the attestor wallet | shim (SH-PAU-2) |
| `amend_terms` | 9 | amendTerms with a co-signing attestor | shim (SH-AMD-1) |
| `claim_final` | 9 | claimFinal | direct |
| `process_orders` | 9 | none (canonical clearing delivers inside clearTransferWindow) | shim (SH-WIN-7) |
| `extinguish` | 6 | extinguish with a co-signing attestor | shim (SH-EXT-1) |
| `request_pause` | 6 | requestPause (until supplied by the runner) | shim (SH-PAU-1) |
| `burn_retired` | 5 | burnRetired (permissionless; sent by the keeper) | direct |
| `retire_if_capped` | 5 | none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment) | blocked (BLK-1) |
| `close_router_period` | 3 | none | not yet (S5) |
| `end_pause` | 3 | none (crankPause ends a pause at its end only) | not yet (S5) |
| `pay_trueup` | 3 | none (tier-3 true-up) | not yet (S5) |
| `set_fx_pair` | 3 | none (admin FX pair configuration) | not yet (S5) |
| `withdraw_pause_request` | 3 | none | not yet (S5) |
| `register_holder` | 2 | registerHolder | direct |
| `set_flags` | 2 | pauseNewRaises (Stage 1 also has windows_enabled) | not yet (S5) |
| `transfer_units` | 2 | none: a direct unit transfer, used only inside expect_revert (DirectTransferForbidden); the canonical model has no transfer to refuse | n/a (NA-1) |
| `cancel_raise` | 1 | cancelRaise | direct |
| `resume_issuance` | 1 | none | not yet (S5) |
| `revoke_attestor` | 1 | registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace) | shim (SH-REG-2) |
| `stop_issuance` | 1 | stopIssuance | not yet (S5) |

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

# VECTOR_PARITY.md

Stage 1 vectors in $STAGE1_PATH/packages/vectors at 5eafd41 (Stage 1 format). Replay through the Stage 1 vector runner is pending; inventory only.

| Vector | Steps | Expect checks | Expected reverts | Ops without a direct counterpart |
| --- | --- | --- | --- | --- |
| 01_happy_path.json | 67 | 10 | 9 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `retire_if_capped` |
| 02_failed_auction.json | 38 | 4 | 7 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 03_auction_edges.json | 78 | 7 | 12 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 04_zero_quarters.json | 81 | 7 | 6 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 05_cap_hit.json | 54 | 6 | 4 | `amend_terms`, `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `retire_if_capped` |
| 06_redemption_terms.json | 116 | 9 | 5 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 07_late_payment.json | 59 | 10 | 2 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 08_hardship_pause.json | 64 | 7 | 8 | `begin_settlement`, `create_series`, `deliver_bid`, `end_pause`, `finalize_settlement`, `process_bid`, `withdraw_pause_request` |
| 09_tail_clause.json | 95 | 7 | 4 | `begin_settlement`, `claim_tail`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 10_transfer_window.json | 92 | 6 | 12 | `begin_settlement`, `begin_window_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders`, `set_flags` |
| 11_extinguishment.json | 52 | 4 | 7 | `amend_terms`, `begin_settlement`, `claim_final`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `revoke_attestor` |
| 12_multi_series_router.json | 118 | 10 | 6 | `begin_settlement`, `close_router_period`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `resume_issuance`, `route_income` |
| 13_fx.json | 281 | 5 | 10 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `set_fx_pair` |
| 14_amendment.json | 83 | 6 | 8 | `amend_terms`, `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `retire_if_capped` |
| 15_zero_valid_bids.json | 35 | 4 | 7 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 16_demand_limited_window.json | 77 | 6 | 0 | `begin_settlement`, `begin_window_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders`, `set_flags` |
| 17_undelivered_winner.json | 51 | 4 | 4 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `register_holder` |
| 18_report_before_finalization.json | 51 | 6 | 5 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `retire_if_capped`, `route_income` |
| 19_pause_while_late.json | 60 | 8 | 4 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 20_tier3_trueup.json | 120 | 11 | 12 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `pay_trueup`, `process_bid`, `submit_trueup` |
| 21_entry_rules.json | 61 | 5 | 10 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `withdraw_pause_request` |
| 22_late_holder_tail_final.json | 111 | 6 | 1 | `begin_settlement`, `begin_window_settlement`, `claim_final`, `claim_tail`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders`, `register_holder` |
| 23_redeem_twice_with_tail.json | 63 | 2 | 0 | `begin_settlement`, `begin_window_settlement`, `claim_tail`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders` |
| 24_inverted_fx.json | 94 | 2 | 0 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `set_fx_pair` |
| 25_window_on_terminal.json | 91 | 2 | 0 | `begin_settlement`, `begin_window_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders` |

## Ops used and their canonical counterpart

| Op | Uses | Canonical | Kind |
| --- | --- | --- | --- |
| `fx_snapshot` | 282 | snapshotRate | direct |
| `submit_report` | 173 | submitReport | direct |
| `expect` | 154 | runner assertion | harness |
| `commit_bid` | 151 | commitBid | direct |
| `deliver_bid` | 149 | claimRefund for losers; none for winners | reshaped |
| `process_bid` | 147 | none (canonical settlement mints and refunds inside settleAuction / claimRefund) | missing |
| `reveal_bid` | 145 | revealBid | direct |
| `expect_revert` | 143 | runner assertion (canonical error names) | harness |
| `fund` | 136 | simulator fund (test faucet) | harness |
| `pay` | 87 | payIn | direct |
| `claim` | 81 | claimPayout | direct |
| `register_attestor` | 51 | registerAttestor | direct |
| `begin_settlement` | 42 | settleAuction (one step; Stage 1 is proposer claims + paged tally + finalize) | reshaped |
| `create_series` | 41 | createSeries (Stage 1 adds tier_flags, fx_pair_id, mode, release schedule, k, fee bps per series) | reshaped |
| `claim_release` | 41 | drawRelease | direct |
| `finalize_settlement` | 39 | settleAuction | reshaped |
| `open_raise` | 38 | openRaise | direct |
| `allowlist` | 27 | setAllowlist | direct |
| `register_verifier_key` | 25 | registerVerifierKey | direct |
| `register_issuer` | 25 | registerIssuer | direct |
| `claim_redemption` | 21 | claimRedemption | direct |
| `reveal_order` | 20 | revealWindowOrder | direct |
| `redeem` | 17 | redeem | direct |
| `claim_tail` | 16 | none (canonical tail pays through the payout accumulator) | missing |
| `crank_status` | 15 | crankStatus | direct |
| `begin_window_settlement` | 14 | clearTransferWindow (one step; Stage 1 is proposer + tally + finalize) | reshaped |
| `commit_ask` | 13 | commitWindowOrder(side=ask) | direct |
| `finalize_window` | 13 | clearTransferWindow | reshaped |
| `open_window` | 12 | openTransferWindow | direct |
| `window_commit_bid` | 11 | commitWindowOrder(side=bid) | direct |
| `route_income` | 11 | postSplitReceipt | reshaped |
| `submit_trueup` | 11 | none (tier-3 true-up) | missing |
| `approve_pause` | 10 | approvePause | direct |
| `amend_terms` | 9 | amendTerms (Stage 1 carries tier-1 θ/r plaintext) | reshaped |
| `process_orders` | 9 | none (canonical clearing delivers inside clearTransferWindow) | missing |
| `claim_final` | 9 | none (canonical extinguishment pays through the payout accumulator) | missing |
| `request_pause` | 6 | requestPause | direct |
| `extinguish` | 6 | extinguish | direct |
| `retire_if_capped` | 5 | none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment) | missing |
| `burn_retired` | 5 | crankBurn | direct |
| `withdraw_pause_request` | 3 | none | missing |
| `end_pause` | 3 | crankPause | reshaped |
| `close_router_period` | 3 | none | missing |
| `set_fx_pair` | 3 | none (admin FX pair configuration) | missing |
| `pay_trueup` | 3 | none (tier-3 true-up) | missing |
| `transfer_units` | 2 | none: a direct unit transfer, used only inside expect_revert (DirectTransferForbidden); the canonical model has no transfer to refuse | harness |
| `set_flags` | 2 | pauseNewRaises (Stage 1 also has windows_enabled) | reshaped |
| `register_holder` | 2 | none (canonical holders are implicit in positions) | missing |
| `cancel_raise` | 1 | cancelRaise | direct |
| `revoke_attestor` | 1 | registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace) | reshaped |
| `stop_issuance` | 1 | stopIssuance | direct |
| `resume_issuance` | 1 | none | missing |

## Expect fields

- `series` × 154
- `balances` × 154
- `feeCollector` × 154
- `treasury` × 154
- `vault` × 154
- `auctionEscrow` × 154
- `ledger` × 154
- `auction` × 154
- `holders` × 154
- `windowEscrowStable` × 21
- `windowEscrowUnits` × 21
- `window` × 21
- `routerBalance` × 15
- `fx` × 6

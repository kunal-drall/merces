# VECTOR_PARITY.md

Stage 1 vectors in $STAGE1_PATH/packages/vectors at 5eafd41 (Stage 1 format). Replay through the Stage 1 vector runner is pending; inventory only.

| Vector | Steps | Expect checks | Expected reverts | Ops without a direct counterpart |
| --- | --- | --- | --- | --- |
| 01_happy_path.json | 67 | 10 | 9 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 02_failed_auction.json | 38 | 4 | 7 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 03_auction_edges.json | 78 | 7 | 12 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 04_zero_quarters.json | 81 | 7 | 6 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 05_cap_hit.json | 54 | 6 | 4 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 06_redemption_terms.json | 116 | 9 | 5 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 07_late_payment.json | 59 | 10 | 2 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 08_hardship_pause.json | 64 | 7 | 8 | `begin_settlement`, `create_series`, `deliver_bid`, `end_pause`, `finalize_settlement`, `process_bid`, `withdraw_pause_request` |
| 09_tail_clause.json | 95 | 7 | 4 | `begin_settlement`, `claim_tail`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 10_transfer_window.json | 92 | 6 | 12 | `begin_settlement`, `begin_window_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders`, `set_flags` |
| 11_extinguishment.json | 52 | 4 | 7 | `begin_settlement`, `claim_final`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `revoke_attestor` |
| 12_multi_series_router.json | 118 | 10 | 6 | `begin_settlement`, `close_router_period`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `resume_issuance`, `route_income` |
| 13_fx.json | 281 | 5 | 10 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `set_fx_pair` |
| 14_amendment.json | 83 | 6 | 8 | `amend_terms`, `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `retire_if_capped` |
| 15_zero_valid_bids.json | 35 | 4 | 7 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 16_demand_limited_window.json | 77 | 6 | 0 | `begin_settlement`, `begin_window_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `finalize_window`, `process_bid`, `process_orders`, `set_flags` |
| 17_undelivered_winner.json | 51 | 4 | 4 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid` |
| 18_report_before_finalization.json | 51 | 6 | 5 | `begin_settlement`, `create_series`, `deliver_bid`, `finalize_settlement`, `process_bid`, `route_income` |
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
| `fx_snapshot` | 278 | snapshotRate | direct |
| `expect` | 154 | runner assertion | harness |
| `submit_report` | 147 | submitReport | direct |
| `commit_bid` | 143 | commitBid | direct |
| `process_bid` | 143 | none (canonical settlement mints and refunds inside settleAuction / claimRefund) | missing |
| `deliver_bid` | 143 | claimRefund for losers; none for winners | reshaped |
| `expect_revert` | 143 | runner assertion (canonical error names) | harness |
| `reveal_bid` | 140 | revealBid | direct |
| `fund` | 136 | simulator fund (test faucet) | harness |
| `pay` | 84 | payIn | direct |
| `claim` | 78 | claimPayout | direct |
| `register_attestor` | 51 | registerAttestor | direct |
| `begin_settlement` | 38 | settleAuction (one step; Stage 1 is proposer claims + paged tally + finalize) | reshaped |
| `finalize_settlement` | 38 | settleAuction | reshaped |
| `create_series` | 36 | createSeries (Stage 1 adds tier_flags, fx_pair_id, mode, release schedule, k, fee bps per series) | reshaped |
| `open_raise` | 36 | openRaise | direct |
| `claim_release` | 29 | drawRelease | direct |
| `allowlist` | 27 | setAllowlist | direct |
| `register_verifier_key` | 25 | registerVerifierKey | direct |
| `register_issuer` | 25 | registerIssuer | direct |
| `claim_redemption` | 20 | claimRedemption | direct |
| `reveal_order` | 20 | revealWindowOrder | direct |
| `crank_status` | 15 | crankStatus | direct |
| `claim_tail` | 14 | none (canonical tail pays through the payout accumulator) | missing |
| `begin_window_settlement` | 13 | clearTransferWindow (one step; Stage 1 is proposer + tally + finalize) | reshaped |
| `finalize_window` | 13 | clearTransferWindow | reshaped |
| `commit_ask` | 11 | commitWindowOrder(side=ask) | direct |
| `route_income` | 10 | postSplitReceipt | reshaped |
| `window_commit_bid` | 9 | commitWindowOrder(side=bid) | direct |
| `claim_final` | 9 | none (canonical extinguishment pays through the payout accumulator) | missing |
| `redeem` | 8 | redeem | direct |
| `open_window` | 8 | openTransferWindow | direct |
| `process_orders` | 8 | none (canonical clearing delivers inside clearTransferWindow) | missing |
| `request_pause` | 6 | requestPause | direct |
| `burn_retired` | 5 | crankBurn | direct |
| `withdraw_pause_request` | 3 | none | missing |
| `approve_pause` | 3 | approvePause | direct |
| `extinguish` | 3 | extinguish | direct |
| `close_router_period` | 3 | none | missing |
| `submit_trueup` | 3 | none (tier-3 true-up) | missing |
| `set_flags` | 2 | pauseNewRaises (Stage 1 also has windows_enabled) | reshaped |
| `set_fx_pair` | 2 | none (admin FX pair configuration) | missing |
| `amend_terms` | 2 | amendTerms (Stage 1 carries tier-1 θ/r plaintext) | reshaped |
| `pay_trueup` | 2 | none (tier-3 true-up) | missing |
| `end_pause` | 1 | crankPause | reshaped |
| `revoke_attestor` | 1 | registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace) | reshaped |
| `stop_issuance` | 1 | stopIssuance | direct |
| `resume_issuance` | 1 | none | missing |
| `retire_if_capped` | 1 | none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment) | missing |
| `register_holder` | 1 | none (canonical holders are implicit in positions) | missing |

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
- `note` × 147
- `windowEscrowStable` × 21
- `windowEscrowUnits` × 21
- `window` × 21
- `routerBalance` × 15
- `fx` × 6

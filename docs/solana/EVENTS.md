# Solana events (SPEC v1.1 §10)

Every event is an Anchor `#[event]` emitted with `emit!` (a `Program data: <base64>` log line:
8-byte discriminator = `sha256("event:<Name>")[..8]`, then the Borsh-encoded fields). Field names
are the SPEC's snake_case names; the EVM contracts use the same names in camelCase. `Pubkey` fields
are 32 bytes, `[u8; 20]` fields are secp256k1 key addresses, `u128` fields are WAD accumulators.

Indexers decode with the IDLs in `solana/idls/` (`events` section; regenerate with
`bash solana/scripts/build.sh && bash solana/scripts/export-idls.sh`). The test harness decodes the
same way (`solana/tests/src/events.rs`); `solana/tests/tests/idl_export.rs` fails when the committed
IDLs drift from the build.

## Registry (`merces_registry`)

| Event | Fields | Emitted by |
| --- | --- | --- |
| `ProtocolInitialized` | `admin, allowlist_manager, fee_collector, chain_id: u64, domain: [u8;32], protocol_program, protocol_authority` | `init_protocol` |
| `AdminTransferStarted` | `admin, pending_admin` | `transfer_admin` |
| `AdminTransferred` | `old_admin, new_admin` | `accept_admin` |
| `AllowlistManagerSet` | `allowlist_manager` | `set_allowlist_manager` |
| `FeeCollectorSet` | `fee_collector` | `set_fee_collector` |
| `FlagsSet` | `new_raises_paused, windows_enabled, tier4_enabled` | `set_flags` |
| `EarlyDrawApproverSet` | `approver` | `set_early_draw_approver` |
| `DefaultsSet` | `defaults: ParametersData` | `set_defaults` |
| `AttestorRegistered` | `addr: [u8;20]` | `register_attestor` |
| `AttestorRevoked` | `addr, revoked_at: u64` | `revoke_attestor` |
| `VerifierKeyRegistered` | `addr` | `register_verifier_key` |
| `VerifierKeyRevoked` | `addr, revoked_at` | `revoke_verifier_key` |
| `FxPairSet` | `pair_id, feed_id, inverted, crosscheck, crosscheck_effective_period: u32, enabled` | `set_fx_pair`, `set_fx_pair_enabled`, `set_fx_crosscheck` (`crosscheck` = the new feed, `crosscheck_effective_period` = the period from which it applies; the previous feed stays in force before it) |
| `IssuerRegistered` / `IssuerDeactivated` | `wallet` | `register_issuer` / `deactivate_issuer` |
| `IssuanceStopped` / `IssuanceResumed` | `wallet` | `stop_issuance` / `resume_issuance` |
| `AllowlistUpdated` | `wallet, allowed` | `set_allowed` |
| `SeriesCreated` | `series, series_id: u64, issuer, mode: u8, stablecoin, units_offered, reserve_price, min_raise, cap_multiple_wad, hurdle_rate_wad, k: u16, lockup_seconds, wallet_cap_bps, auction_fee_bps, payout_fee_bps, window_fee_bps, non_reveal_charge_bps, terms_commitment, tier_flags: u8, fx_pair_id` | `create_series` |
| `ContractHashSet` | `series, hash` | `set_contract_hash` |
| `TermsAmended` | `series, nonce: u64, new_terms_commitment, new_cap_multiple_wad, attestor: [u8;20]` | `amend_terms` |
| `RaiseStateChanged` | `series, state: u8` (§1.7 `RaiseState`) | `mark_raise_opened`, `mark_raise_result`, `mark_curve_activated` |
| `MintFinalized` | `series` | `mark_mint_finalized` (settled raises and, with an empty mint, failed raises) |
| `TerminalStatusSet` | `series, status: u8` (4 Retired, 5 Redeemed, 6 Extinguished) | `mark_terminal` |
| `CurveActivated` | `series, dbc_config, dbc_pool, base_mint, dbc_creator, units_sold, clearing_price` (`units_sold` = the config's `swap_base_amount` in base lamports, `clearing_price` = `P0` per whole unit) | `mark_curve_activated` (CPI from `activate_curve`; the series moves Draft → Open, with `RaiseStateChanged`) |

## Protocol (`merces_protocol`)

### Raise (§5)

| Event | Fields | Emitted by |
| --- | --- | --- |
| `RaiseOpened` | `series, unit_mint, opened_at, commit_end, reveal_end` | `open_raise` |
| `RaiseCancelled` | `series` | `cancel_raise` (after `MintAuthorityRevoked`) |
| `BidCommitted` | `series, bidder, escrow` | `commit_bid` |
| `BidRevealed` | `series, bidder, price, quantity, valid` | `reveal_bid` |
| `SettlementProposed` | `series, clearing_price, round: u32` | `begin_settlement` |
| `SettlementRejected` | `series, round, clearing_price, reason: u8` (1 ClaimMismatch, 2 InvalidClearingPrice) | `finalize_settlement` (no revert) |
| `RaiseSettled` | `series, clearing_price, units_sold, proceeds, settlement_ts` | `finalize_settlement` |
| `RaiseFailed` | `series, clearing_price, proceeds, min_raise` | `finalize_settlement` |
| `UnitsAllocated` | `series, bidder, units, cost, fee, refund` | `process_bid` (winners) |
| `NonRevealCharged` | `series, bidder, charge` | `process_bid` (unrevealed bids of a settled raise) |
| `RaiseMintFinalized` | `series, units_sold, proceeds` | the last `process_bid` of a settled raise; for a failed raise the last `process_bid`, or `finalize_settlement` when there was no bid, with `units_sold = proceeds = 0` (empty mint) |
| `MintAuthorityRevoked` | `series` | the instruction that finalises the mint, right before `RaiseMintFinalized`; `cancel_raise` |
| `BidDelivered` | `series, bidder, units, refund` | `deliver_bid` |

### Treasury (§5.3)

| Event | Fields | Emitted by |
| --- | --- | --- |
| `ReleaseClaimed` | `series, amount, released_total` | `claim_release` |
| `ReleasePauseSet` | `series, paused` | `set_release_pause` |
| `EarlyDrawExecuted` | `series, amount, approver` | `request_early_draw` |

### Repayment, vault and status (§6)

| Event | Fields | Emitted by |
| --- | --- | --- |
| `ReportAccepted` | `series, period: u32, payment_usd, fx_avg_wad, fx_fallback, tier: u8, liquidity_event, income_commitment, due` | `submit_report` |
| `PaymentSettled` | `series, period, gross, accrual, fee, accepted, refunded` | `submit_report` (zero due) and `pay` |
| `PayoutDistributed` | `series, source: u8` (0 Payment, 1 Router, 2 Tail, 3 Final)`, gross, accepted, fee, net_added, delta_acc_wad: u128, paid_per_unit_wad: u128, retired` | every vault receipt |
| `PayoutClaimed` | `series, holder, amount, burned_units` | `claim` |
| `HolderRegistered` | `series, holder` | `register_holder`, `process_bid` (first allocation), `process_order` (a buyer's first fill); losing and unrevealed bidders get no holder account |
| `UnitsBurned` | `series, holder, units, reason: u8` (0 Retired, 1 Redeemed, 2 Extinguished) | `claim`, `burn_retired` (`units = 0` for a wallet with no balance, as on EVM), `claim_redemption`, `claim_tail`, `claim_final` |
| `SeriesRetired` | `series, paid_per_unit_wad, refund` | the receipt that meets the cap, `retire_if_capped`, `redeem` with `C_rem == 0` |
| `StatusChanged` | `series, old: u8, new: u8` | every `sync_status` that changes the stored status (sync points, as in the reference simulator and the EVM contracts: `submit_report`, `pay`, `pay_trueup`, `submit_trueup`, `route`, `claim_release`, `crank_status`, `approve_pause`, `end_pause`, `open_window`, `redeem`, `extinguish`; other instructions read the derived status without storing it); terminal transitions |
| `FormalNoticeDue` | `series, period: u32, trueup: bool` | `sync_status` once per period (`trueup = false`) and once per true-up (`trueup = true`, `period` = the true-up's calendar year) |
| `PauseRequested` | `series, nonce` | `request_pause` |
| `PauseRequestWithdrawn` | `series, nonce` (the nonce the withdrawn request carried) | `withdraw_pause_request` |
| `PauseApproved` | `series, start, end, attestor` | `approve_pause` |
| `PauseEnded` | `series, paused_total` | `end_pause` |
| `TrueUpRecorded` | `series, year: u16, adjustment: i64, deadline` (0 for a negative adjustment) | `submit_trueup` |
| `TrueUpPaid` | `series, amount, accrual` | `pay_trueup` |
| `IncomeRouted` | `series, amount, pass_through, routed, ytd_received` | `route` |
| `RouterPeriodClosed` | `series, period, ytd_at_end` | `route` (implicit closing) and `close_router_period` |
| `FxSnapshot` | `pair, day: u32, rate_wad, sum_wad: u128, count: u32` | `snapshot_fx` |
| `FxDeviationFlagged` | `pair, period, rate_wad, crosscheck_wad` | `snapshot_fx` when a cross-check feed is in force for the period and deviates beyond `fx_deviation_band_bps` (the checkpoint is flagged; the snapshot still counts) |
| `SeriesRedeemed` | `series, price, hurdle, d_avg, cap_remaining, units, deposit` | `redeem` |
| `RedemptionClaimed` | `series, holder, units, amount` | `claim_redemption`; also `claim_tail` / `claim_final` when they redeem a balance first |
| `TailDistributed` | `series, period, gross, accepted, fee, refunded` | `pay` on a Redeemed series |
| `TailClaimed` | `series, holder, amount` | `claim_tail` |
| `SeriesExtinguished` | `series, unreleased, attestor_a, attestor_b` | `extinguish` |
| `FinalClaimed` | `series, holder, units, amount` | `claim_final` |

### Curve mode (§9, `docs/meteora/CURVE_MODE.md`)

Units in curve-mode events are base lamports (`10^6` per unit); prices stay per whole unit.

| Event | Fields | Emitted by |
| --- | --- | --- |
| `CurveUnitsSynced` | `series, supply, protocol_held, units_outstanding, staked_total` | `sync_curve_units`, and the census of a curve `redeem` |
| `CurveProceedsCollected` | `series, migration_fee, surplus, trading_fee, proceeds` (`migration_fee` + `surplus` = what reached the treasury in this call, `trading_fee` = what reached the fee collector, `proceeds` = the treasury's total afterwards) | `collect_curve_proceeds` (also when nothing was due: all zero) |
| `UnitsStaked` | `series, holder, units, staked` (the holder's stake afterwards) | `stake_units` |
| `UnitsUnstaked` | `series, holder, units, staked` | `unstake_units` |

Existing events in curve mode: `RaiseOpened` (`activate_curve`; `unit_mint` = the DBC base mint,
`commit_end = reveal_end = 0`); `RaiseSettled` and `RaiseMintFinalized` (`complete_curve`;
`settlement_ts = finish_curve_timestamp`, `units_sold` = design units, `proceeds = 0` because the
proceeds arrive later through `CurveProceedsCollected`), with the registry's `RaiseStateChanged`
and `MintFinalized`; `UnitsBurned` (reason 1 Redeemed) followed by `RedemptionClaimed` from
`tender_units` (the amount includes any pending payout settled first); `PayoutClaimed` with
`burned_units = 0` (claims never burn: `UnitsBurned` reason 0 is never emitted in curve mode);
`FinalClaimed` with the staked (or, after a redemption, tendered) units as `units` and no burn.
`SeriesRedeemed.units` is the census at redemption. No `BidCommitted` / window / `MintAuthorityRevoked`
event exists for a curve series.

### Transfer window (§7)

| Event | Fields | Emitted by |
| --- | --- | --- |
| `WindowOpened` | `series, period, commit_end, reveal_end` | `open_window` |
| `OrderCommitted` | `series, period, owner, side: u8` (0 bid, 1 ask)`, escrow` | `commit_ask`, `window_commit_bid` |
| `OrderRevealed` | `series, period, owner, side, price, quantity, valid` | `reveal_order` |
| `WindowSettlementProposed` | `series, period, clearing_price` (`u64::MAX` for NO_MATCH)`, no_match: bool, round: u32` | `begin_window_settlement` (same fields as the EVM event) |
| `WindowSettlementRejected` | `series, period, clearing_price` (`u64::MAX` for NO_MATCH)`, reason: u8` (1 NoMatchInvalid, 2 PriceNotRevealed, 3 NoCrossing) | `finalize_window` (no revert) |
| `WindowCleared` | `series, period, clearing_price, matched_units, branch: u8` (0 SupplyLimited, 1 DemandLimited) | `finalize_window` |
| `WindowNoMatch` | `series, period` | `finalize_window` |
| `OrderFilled` | `series, period, owner, side, fill, price` (0 after NO_MATCH)`, fee, refund` (stablecoin for bids, returned units for asks) | `process_order` (accounting: the fee is paid here, `refund` and the units / proceeds are recorded on the order for `deliver_order`) |
| `WindowTakebackProposed` | `series, period, price, reveal_index, round: u32` | `begin_takeback` (proposed threshold ask below `p*`) |
| `WindowTakebackRejected` | `series, period, round` | `finalize_takeback` when the tally disproves the proposal (no revert; a new round may start) |
| `WindowTakebackSettled` | `series, period, cancelled_units, below_units, price, reveal_index, partial` | `finalize_takeback` (accepted threshold: asks below `p*` with a larger `(price, reveal_index)` give back everything, the threshold ask gives back `partial`) |
| `OrderDelivered` | `series, period, owner, side, units, amount` | `deliver_order` (units bought or returned; stablecoin refund or proceeds) |

## Hook (`merces_hook`)

The hook emits no events; its failures are `HookError` codes (`DirectTransferForbidden`,
`UnarmedEscrowDeposit`, `ProgramCalledOutsideOfTransfer`, `CurveModeNoHook`, `SeriesMintMismatch`,
`EscrowArmMismatch`, `MintAuthorityMismatch`, `InvalidTokenAccount`, `ExtraAccountsMismatch`) surfaced
through the Token-2022 CPI.

## Differences from the SPEC §10 list (recorded in `docs/assumptions/track-b.md`)

- `FormalNoticeDue` carries an extra `trueup: bool` so the `FormalNoticeDue(series, trueup)` of §6.4
  fits the §10 signature; `period` is the calendar year for the true-up variant (B-S3).
- `PauseRequestWithdrawn` reports the nonce of the withdrawn request (the ledger then advances it).
- `BidRefunded` (v1.0) no longer exists: refunds are `BidDelivered.refund`.
- Not in the v1.1 §10 list but required by §12 ("every state transition emits an event"):
  `WindowSettlementProposed` (also emitted by the EVM contracts with the same fields),
  `MintFinalized` (registry), and the Solana-only `WindowTakebackProposed`,
  `WindowTakebackRejected`, `WindowTakebackSettled` (the paged take-back below `p*`, B-S12) and
  `OrderDelivered` (two-step window settlement, B-S13). The EVM contracts have their own
  chain-specific events (`PaymentDeferred`, `OwedWithdrawn`) for the same liveness requirement.
- SPEC v1.1.1 §10 (item 19) added these names with shorter field lists than the implementation
  above: `WindowSettlementProposed(series, period, clearing_price, round)`, `WindowTakebackProposed(
  series, period, threshold)`, `WindowTakebackRejected(series, period, threshold, reason)` and
  `WindowTakebackSettled(series, period, cancelled_units)`. Both chains carry `no_match` on
  `WindowSettlementProposed` and `below_units` on `WindowTakebackSettled`, so an indexer sees those
  on both; the remaining Solana-only fields are the take-back `round`, `price`, `reveal_index` and
  `partial`. Recorded as B-S23; the lead decides whether the SPEC lists or the events change.
- Curve mode (§9 lists no events): `CurveActivated` gains `dbc_creator` (the DBC pool creator, issuer
  wallet or `curve_authority`, CURVE_MODE §6); `CurveUnitsSynced`, `CurveProceedsCollected`,
  `UnitsStaked`, `UnitsUnstaked` are Solana-only (B-C1, B-C4, B-C5 in `docs/assumptions/track-b.md`).

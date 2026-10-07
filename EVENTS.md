# Events

Every state transition on both chains emits an event with the fields below. Names are identical on both chains;
Solana events are Anchor `#[event]` structs (snake_case fields, emitted with `emit!`), EVM events use the same names
with camelCase fields. Types: `series` is the series key (Solana: series PDA pubkey; EVM: `uint64 seriesId`),
`wallet`/`holder`/`bidder` are chain-native addresses, amounts are stablecoin base units (`u64`), WAD values are
`u128` (Solana) / `uint256` (EVM), timestamps unix seconds, `period` is `year × 4 + quarter − 1`.
Chain-specific type details and indexed fields: `docs/solana/EVENTS.md`, `docs/evm/EVENTS.md`.

## Registry

| Event | Fields | Meaning |
| --- | --- | --- |
| `ProtocolInitialized` | `admin, allowlist_manager, fee_collector, chain_id, domain` | One-time protocol setup |
| `AdminTransferStarted` / `AdminTransferred` | `current_admin, pending_admin` / `old_admin, new_admin` | Two-step admin handover |
| `AllowlistManagerSet` | `manager` | |
| `FeeCollectorSet` | `fee_collector` | New fee destination for future fee transfers |
| `FlagsSet` | `new_raises_paused, windows_enabled, tier4_enabled` | Protocol switches |
| `EarlyDrawApproverSet` | `approver` | Zero = early draws disabled |
| `DefaultsSet` | all `Parameters` of SPEC §1.6 | Defaults for future series only |
| `AttestorRegistered` / `AttestorRevoked` | `addr20` | secp256k1 attestor key set |
| `VerifierKeyRegistered` / `VerifierKeyRevoked` | `addr20` | Stage 2 report-verifier keys (tier 2) |
| `FxPairSet` | `pair_id, feed_id, inverted, crosscheck, enabled` | FX pair configuration |
| `IssuerRegistered` / `IssuerDeactivated` | `issuer` | Invite-only issuer set; deactivation blocks new series only |
| `IssuanceStopped` / `IssuanceResumed` | `issuer` | Issuer's own switch (C11 §5) |
| `AllowlistUpdated` | `wallet, allowed` | EVM: mirrors identity-registry membership |
| `SeriesCreated` | `series, issuer, mode, stablecoin, units_offered, reserve_price, min_raise, cap_multiple_wad, hurdle_rate_wad, payout_multiple_k, lockup_seconds, wallet_cap_bps, auction_fee_bps, payout_fee_bps, window_fee_bps, non_reveal_charge_bps, commit_duration, reveal_duration, terms_commitment, tier_flags, fx_pair_id` | Full charter snapshot at creation; the indexer never needs to read state for terms |
| `ContractHashSet` | `series, contract_hash` | Signed legal contract anchored |
| `TermsAmended` | `series, nonce, new_terms_commitment, new_cap_multiple_wad, attestor` | Favourable amendment (issuer + attestor) |
| `RaiseStateChanged` | `series, state` | Draft/Open/Reveal/Settling/Settled/Failed/Cancelled |
| `TerminalStatusSet` | `series, status` | Retired / Redeemed / Extinguished mirrored into the registry |

## Raise path

| Event | Fields | Meaning |
| --- | --- | --- |
| `RaiseOpened` | `series, unit_mint, opened_at, commit_end, reveal_end` | Auction phases fixed |
| `RaiseCancelled` | `series` | Issuer cancelled before any bid |
| `BidCommitted` | `series, bidder, escrow` | Sealed commitment stored; escrow pulled |
| `BidRevealed` | `series, bidder, price, quantity, valid` | `valid == false` → refunded in full later |
| `SettlementProposed` | `series, clearing_price, round` | Keeper proposal; starts a tally round |
| `RaiseSettled` | `series, clearing_price, units_sold_upper, proceeds_upper, settlement_ts` | Lockup and reporting clocks start at `settlement_ts` |
| `RaiseFailed` | `series, clearing_price, proceeds_upper, min_raise` | Everything refundable in full, no fees |
| `UnitsAllocated` | `series, bidder, units, cost, fee, refund` | Winner processed: units minted, cost → treasury, fee → collector |
| `BidRefunded` | `series, bidder, refund, charge` | Loser / invalid / failed-auction refund (`charge` is 0 unless unrevealed) |
| `NonRevealCharged` | `series, bidder, charge` | Non-reveal charge taken (parameter) |
| `RaiseMintFinalized` | `series, units_sold, proceeds` | Exact totals after the last bid; mint authority revoked |
| `MintAuthorityRevoked` | `series` | No more units can ever be minted (Solana) / minter role dropped (EVM) |
| `ReleaseClaimed` | `series, amount, released_total` | Issuer pulled vested funds |
| `ReleasePauseSet` | `series, paused` | Issuer's own release pause |
| `EarlyDrawExecuted` | `series, amount, approver` | Only when an approver is configured |

## Repayment path

| Event | Fields | Meaning |
| --- | --- | --- |
| `ReportAccepted` | `series, period, payment_usd, fx_avg_wad, fx_fallback, tier, liquidity_event, income_commitment, due` | Proof + attestation verified; `due` = payment after router credits |
| `PaymentSettled` | `series, period, gross, accrual, fee, accepted, refunded` | Issuer paid; `accepted` after cap truncation, `refunded` back to the issuer |
| `PayoutDistributed` | `series, source, gross, accepted, fee, net_added, delta_acc_wad, paid_per_unit_wad, retired` | Accumulators moved; `source` ∈ Payment/Router/Tail/Final |
| `HolderRegistered` | `series, holder` | Snapshot of the accumulator taken for a new holder |
| `PayoutClaimed` | `series, holder, amount, burned_units` | Net payout pulled; units burned if Retired |
| `UnitsBurned` | `series, holder, units, reason` | reason ∈ Retired/Redeemed/Extinguished |
| `SeriesRetired` | `series, paid_per_unit_wad, refund` | Cap reached; final truncated payment |
| `StatusChanged` | `series, old, new` | C8 status transition (derived) |
| `FormalNoticeDue` | `series, period` | 90 days late; legal notice under the contract |
| `PauseRequested` | `series` | Issuer asked; no reason stored |
| `PauseApproved` | `series, start, end, attestor` | Hardship pause in force |
| `PauseEnded` | `series, paused_total` | Ended early by the issuer |
| `IncomeRouted` | `series, amount, pass_through, routed, ytd_received` | Tier-1 split |
| `TrueUpRecorded` | `series, year, adjustment, deadline` | Tier-3 annual true-up |
| `TrueUpPaid` | `series, amount, accrual` | |
| `FxSnapshot` | `pair, day, rate_wad, sum_wad, count` | Daily keeper snapshot |
| `FxDeviationFlagged` | `pair, period, rate_wad, crosscheck_wad` | Quarter marked NeedsFallback |

## Exit path

| Event | Fields | Meaning |
| --- | --- | --- |
| `SeriesRedeemed` | `series, price, hurdle, d_avg, cap_remaining, units, deposit` | Formula inputs and result |
| `RedemptionClaimed` | `series, holder, units, amount` | Units burned, proceeds paid |
| `TailDistributed` | `series, period, gross, accepted, fee, refunded` | Liquidity-event payout within 12 months |
| `TailClaimed` | `series, holder, amount` | |
| `SeriesExtinguished` | `series, unreleased, attestor_a, attestor_b` | Two attestors; unreleased treasury moved to the vault |
| `FinalClaimed` | `series, holder, units, amount` | Pro rata share of unreleased funds; units burned |

## Transfer window

| Event | Fields | Meaning |
| --- | --- | --- |
| `WindowOpened` | `series, period, commit_end, reveal_end` | |
| `OrderCommitted` | `series, period, owner, side, escrow` | side ∈ Bid/Ask; escrow in stablecoin (bid) or units (ask) |
| `OrderRevealed` | `series, period, owner, side, price, quantity, valid` | |
| `WindowCleared` | `series, period, clearing_price, matched_units` | |
| `WindowNoMatch` | `series, period` | |
| `OrderFilled` | `series, period, owner, side, fill, price, fee, refund` | Per order; `fill` may be 0 |

## Metrics the indexer derives (brief B9)

- On-time reporting rate: `ReportAccepted.period` vs `StatusChanged` to `Late`.
- Share of payments at tiers 1–2: `ReportAccepted.tier`.
- Payout accuracy: `PayoutDistributed` vs `PayoutClaimed` sums.
- Auctions meeting the minimum raise: `RaiseSettled` vs `RaiseFailed`.
- Disputes and hardship pauses: `PauseApproved`, `FormalNoticeDue`.

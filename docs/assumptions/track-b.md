# Track B assumptions, interpretations and SPEC defects (SPEC v1.1, Solana)

Track B = `solana/`: `merces_registry` (D1 + D11), `merces_hook` (D2), `merces_protocol`
(D3–D9, C9) and `mock_usdg_hook`, the shared crates `crates/merces-common` (pure math, `no_std`)
and `crates/merces-onchain` (syscall glue), the LiteSVM test harness, the SPEC §11 vector runner,
measurements and deploy scripts. Every reading, default and defect found while implementing SPEC.md
v1.1 is listed here with the section it concerns. "Vectors" says which parity vector pins it.

## SPEC defects and gaps

| # | Section | Defect / gap | What Solana does | Vectors |
| --- | --- | --- | --- | --- |
| B-S1 | §6.3, §6.8, §6.9 carry | Fixed by the lead on 8 Oct (exact WAD remainder, Track A defect S1). The ledger fields are `carry_wad`, `tail_carry_wad`, `final_carry_wad` as `u64` (the remainder is `< N ≤ 2^64`), not `u128`. | `num = net × WAD + carry_wad; delta = num / N; carry_wad = num mod N`, one per accumulator; `net_added = accepted − fee`. | every paying vector (`carryWad`) |
| B-S2 | §4.1 extra account metas | The list names three accounts and derives `EscrowArm` from `AccountData{account_index: 1, data_index: 0, length: 32}`; the mint is an *account key* (index 1 of `Execute`), not data inside an account, and the external PDA needs its program as an account to resolve. | Four entries: `[ProtocolConfig (literal), Series (literal), merces_protocol (literal), EscrowArm = external PDA(merces_protocol, [b"escrow_arm", AccountKey{index: 1}])]`; `check_account_infos` validates the list. | 10, 16, 17 (hook paths) |
| B-S3 | §6.4 `FormalNoticeDue(series, trueup)` | The true-up notice does not fit the §10 signature `FormalNoticeDue(series, period)`. | Field `trueup: bool` added; `period` carries the true-up's calendar year when `trueup = true`. | 20 (event only) |
| B-S4 | §5.2 step 4/5 | `units_sold = q_above + alloc_sum` can be 0 with marginal shares below one unit (`N − q_above < #marginal bidders`); `mark_raise_result(Settled, …)` requires `units_sold ≥ 1`. | Treated as `Failed` (`RaiseFailed(series, p*, 0, min_raise)`); only reachable when `min_raise == 0`. | — |
| B-S5 | §5.3 `request_early_draw` after extinguishment | Not addressed. `released_total + amount ≤ proceeds` could draw funds that moved to the vault. | Early draws revert `SeriesExtinguished` once the estate is fixed. | — |
| B-S6 | §6.9 `unreleased = proceeds − vested(now)` | With early draws `released_total` may exceed `vested(now)`; the treasury then holds less than `proceeds − vested(now)`. | `unreleased = proceeds − max(vested(now), released_total)`; the estate's `claim_release` cap is `vested(extinguished_at)` so it reads 0 after such draws. | 11 (no early draw) |
| B-S7 | §6.5 ring of 8 checkpoints | A tier-1 issuer more than 8 quarters behind loses the checkpoints of its next expected period (ring overwrite) and can no longer report tier 1. | Kept as specified (ring of 8, SPEC text); such a series is at least 7 quarters Late. Flag for the lead: a per-period checkpoint PDA would remove the limit. | 12 |
| B-S8 | §6.6 staleness/confidence parameters | `fx_max_staleness_seconds` and `fx_max_conf_bps` are per-series parameters, but a pair's accumulator is shared by every series of the pair. | Snapshots use the protocol defaults in force (`ProtocolConfig.defaults`). | 13 |
| B-S9 | §7 `process_order` ordering | SPEC orders only the marginal side, but a cancelled buyer (allowlist removed at fill) changes the asks' budget, so asks cannot be paid before every bid is processed. | Revealed bids in ascending reveal index, then revealed asks in ascending reveal index (`OutOfOrder` otherwise); unrevealed orders and NO_MATCH windows in any order. Marginal fills first-come inside that order. | 10, 16 |
| B-S10 | §3.1 FX pairs | "write-once" vs admin "configure cross-check feeds": a second `set_fx_pair` of the same `(feed_id, inverted)` must revert (vector 13). | `set_fx_pair` is create-only (`FxPairImmutable`); `set_fx_pair_enabled` toggles `enabled`; the cross-check feed is unset on Solana (ASSUMPTIONS A21) and cannot be changed in this version. | 13 |
| B-S11 | VERSIONS.md rustc | LiteSVM 0.17's Agave dependencies require rustc 1.97.1 (`solana/rust-toolchain.toml`); VERSIONS.md still says 1.97.0. | Lead to update VERSIONS.md. | — |

## Interpretations and defaults

| # | Section | Reading |
| --- | --- | --- |
| B-1 | §0 one program | `merces_protocol` is one program with one zero-copy `Ledger` per series (784 bytes); the registry and the hook read it only through its byte layout (`EscrowArm` at offsets 8..48 for the hook). Cross-program reads use the `merces_registry` crate types (`cpi` / `no-entrypoint` features), not `declare_program!`. |
| B-2 | §3.2 write interface | `registry_authority = PDA(["registry_authority"], merces_protocol)`, stored at `init_protocol` from `protocol_program`; `mark_raise_result` is written once (Open/Settling → Settled/Failed; Open → Cancelled), `mark_mint_finalized` once, `mark_terminal` only forward (Retired/Redeemed → Extinguished). |
| B-3 | §4.1 mint | `open_raise` creates the mint with `TransferHook` (authority None, immutable hook), `PermanentDelegate = vault_auth`, `MetadataPointer → self`, `TokenMetadata { "Merces HEU <id>", "HEU", metadata_uri }`; the two unit escrows are ATAs of the `auction_escrow` / `window_escrow` PDAs created in the same instruction, after the registry has mapped the mint (the hook's `initialize_extra_account_meta_list` requires `Series.unit_mint == mint`). `prepare_raise` precedes it (stack-frame limit): Auction, Treasury, Ledger, EscrowArm and the four stablecoin PDAs. |
| B-4 | §4.1 hook rule 4 | `commit_ask` writes `EscrowArm{owner, units}` and serialises it before the transfer CPI, then clears it in the same instruction; a non-zero arm left by a failed instruction is impossible (atomic), and `EscrowArmBusy` guards a reentrant arm. |
| B-5 | §5.2 `process_bid` | Mints to the auction escrow ATA and registers the holder with `undelivered_units += alloc` (accrual weight, §6.1); the non-reveal charge goes to the fee collector immediately. The last `process_bid` of a settled raise checks `units_minted == units_sold` and `treasury.proceeds_received == proceeds`, revokes the mint authority, calls `mark_mint_finalized`, stores `units_outstanding` and sets the treasury's `mint_finalized`. A failed raise never finalises a mint (nothing was minted). |
| B-6 | §5.2 `deliver_bid` | Creates the bidder's unit and stablecoin ATAs idempotently (payer funds them) so delivery cannot be blocked by a missing account; the `Holder` account is optional (absent for refund-only bids); `pending_units/pending_refund` are zeroed on delivery (the event carries the amounts). |
| B-7 | §5.3 | `claim_release` cap = `min(vested(at), proceeds)` with `at = extinguished_at` once extinguished; blocked by the issuer's pause, derived `Late`, or `is_late_underlying`. Extinguished series keep releasing what had vested (the estate). |
| B-8 | §6.1 `accrual_units` | `Holder.undelivered_units` (auction escrow) and `Holder.ask_escrow_units` (window escrow) are stored per holder; `settle_holder` uses `balance + undelivered + ask_escrow`. `claim_redemption` and `claim_final` (non-redeemed series) require both to be zero (`DeliverFirst`, `AskEscrowOutstanding`): escrowed units are returned by the permissionless `deliver_bid` / `process_order` first, so nothing is stranded. |
| B-9 | §6.2 key grace | The §1.4 grace (`period_end(period) ≤ revoked_at && now ≤ revoked_at + 45 d`) applies to tier 2 / tier 3 report attestations and to the FX fallback signature of a report; pause, extinguishment, true-up and amendment signatures need an active key. |
| B-10 | §6.2 tier 1 | `income_commitment = Poseidon(2)(ytd_at_end[period], 0)`, `prior = Poseidon(2)(ytd_at_end[period − 1], 0)` except at a year start (ZERO commitment, already enforced by step 5); missing checkpoints revert `RouterPeriodNotClosed`. `init_router` is permissionless, reads `theta / r_wad` from the Series and is allowed only before settlement so a checkpoint exists for every reportable period (`RouterTooLate`). |
| B-11 | §6.2 true-up | `submit_trueup` requires `attestation_ts ≤ now`; the message carries the stored `trueup_nonce` (then incremented); `year < year_of(period_of(now))`, `last_trueup_year < year`, `first_period ≤ year·4+3 ≤ last_accepted_period`; negative adjustments are bounded by a tagged 4-slot ring of Σ `payment_usd` per calendar year (`TrueUpExceedsYear`). The payment's year-gross anchor is `deadline(period_of(trueup_attested_at))`. |
| B-12 | §6.3 year ring | `year_gross.add(settlement_year(anchor))` with `anchor = deadline(period) = period_end + 30 d` for payments and `now` for router receipts; an anchor before `settlement_ts` reads as year 0. |
| B-13 | §6.4 pauses | Up to 16 `{start, end}` pauses stored inline in the ledger; `paused_total` is the approved span, reduced by `end_pause`. `request_pause` increments the nonce; `withdraw_pause_request` increments it again; `approve_pause` consumes the request without touching the nonce (the request flag prevents replay). |
| B-14 | §6.5 terminal statuses | After Retired / Redeemed / Extinguished, `route` passes everything through to the issuer (the vault takes nothing); routed income of a Redeemed series is the issuer's to report as a tail liquidity event. |
| B-15 | §6.6 | One snapshot per UTC day per pair; the first snapshot of a period writes that period's checkpoint PDA; `quarter_average` reads checkpoint `p+1` or the live totals when `last_day × DAY < period_start(p+1)` and `now ≥ period_end(p)` (`FxPair` passed to `submit_report`). Pyth accounts must be `PriceUpdateV2` owned by the receiver program with `VerificationLevel::Full`. |
| B-16 | §6.7 | `redeem` requires status ∈ {OnTime, InGrace, Paused}, lockup over, `open_due_amount == 0 && trueup_due == 0`, every ended period reported, and `C_rem > 0` (else `retire()`); `claim_redemption` adds any `pending` to `P_redeem × units`; `claim_tail` / `claim_final` redeem an unredeemed balance first. |
| B-17 | §6.9 | `extinguish` is allowed in every status but Extinguished (including Retired and Redeemed); `final_units = units_at_redemption` for redeemed series else `units_outstanding`; `unreleased == 0` or `final_units == 0` → no distribution. |
| B-18 | §7 | `open_window` needs the window escrows that `prepare_raise` / `open_raise` created; the wallet-cap check at reveal uses `Ledger.units_outstanding` (= mint supply after finalisation). A buyer whose allowlist entry is missing or `allowed = false` at fill is cancelled (full refund) and the asks' budget shrinks accordingly; sellers are settled before their escrow accounting changes. |
| B-19 | Tests | The mock USDG mint carries `TransferHook` (no-op hook), `TransferFeeConfig` (0/0) and `MetadataPointer`; Token-2022 refuses `ConfidentialTransferMint` next to a transfer-fee config without a confidential-fee config, so that extension is left out (ASSUMPTIONS A24 otherwise holds). The parity vectors run on the SPL mock USDC. |
| B-20 | §11 runner | Canonical error names map to sets of Anchor error codes (`solana/tests/src/vectors.rs::codes_for`); account-existence failures (`BidExists`, `OrderExists`) and bound violations at `create_series` (`InvalidTerms`, `UnknownFxPair`, `RouterNotEnabled`) are accepted as any failure; `AmountOutOfRange` cases are values that Borsh cannot encode into a `u64`/`i64`, so the runner asserts them without a transaction. `expect.ledger.status` is the derived status computed off-chain from the ledger with the step's `t`. |

## Verified by

| What | How |
| --- | --- |
| Pure math (`merces-common`) | unit + proptest tests (`cargo test -p merces-common`) |
| Verifying key and proofs | `zk::tests::vector_proofs_verify_against_vk` (host arkworks), every vector report on-chain |
| Programs | `solana/tests/tests/vectors.rs` (21 parity vectors), `charter.rs` (immutability, write-interface authentication, hook rules, §6.3 invariants, no admin money path), `measure.rs` (compute units) |
| Build hygiene | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `anchor build` with no stack-frame warnings |

## Open items for the lead

- B-S7 (router ring of 8) and B-S10 (`set_fx_pair` create-only) are the only places where the
  Solana behaviour narrows the SPEC text; both follow the vectors.
- `FormalNoticeDue.trueup` (B-S3) should be mirrored by the EVM event or the SPEC §10 signature
  amended.
- Devnet deployment is scripted (`solana/scripts/deploy.ts`) and exercised against
  `solana-test-validator`; the devnet RPC was unreachable from the build environment, so no devnet
  addresses are recorded in `solana/deployments/`.

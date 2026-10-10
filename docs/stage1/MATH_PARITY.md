# MATH_PARITY.md

Stage 1 math imported at 1bfc66b; interim families remaining: FX (S5), window cap (S5).

- Stage 1 math package: packages/reference at 1bfc66b.
- `@merces/math` re-exports 45 Stage 1 reference names (status, vault, redemption, treasury, income, auction); 45 are Stage 1's own objects. It also re-exports `@merces/sdk`'s fixed point, periods, pauses, year ring, parameters and error names.
- No function-by-function comparison: the gateway runs Stage 1's functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file's git history.
- The interim (Part C) math survives only under `interim.*`: since S2, only the window cap (S5; a curve raise has no cap since S3) and the FX family (S5); the sealed-bid auction runs Stage 1's auction family. Any other name there is reported as unclassified.

| Interim family | Names still exported under `interim` |
| --- | --- |
| FX (S5) | `quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`, `pythToWad` |
| window cap (S5) | `walletCapUnits` |

## Ported from Stage 1's Rust (A-MATH-3)

Stage 1's TypeScript has no `unit_scale` and no curve code, so `@merces/math` ports 16 names from merces-common (`solana/crates/merces-common/src`) @1bfc66b, kept apart from the re-exports. They are not Stage 1 objects. At scale 1 each scale-aware one returns Stage 1's own TypeScript function's result (it calls it), so a sealed-bid series runs only Stage 1's functions (`packages/math/test/curve.test.ts` checks that on seeded grids). This step checks each Rust item still exists at the checkout and is unchanged since the port (fingerprint); the `curve-port` step checks what the family computes against Stage 1's figures and Stage 1's Rust on every sync (below). Stage 1 is asked to add `unit_scale` to its TypeScript so these become imports.

Check at this checkout: **ok**. ported family: the merces-common items of all 16 names present and unchanged since the port (@1bfc66b)

| Ported name | merces-common items | At scale 1 (in Stage 1 TypeScript) |
| --- | --- | --- |
| `CURVE_BASE_DECIMALS` | `curve.rs:CURVE_BASE_DECIMALS` | none (curve mode only) |
| `CURVE_UNIT_SCALE` | `curve.rs:CURVE_UNIT_SCALE` | none (curve mode only) |
| `unitScaleFor` | `curve.rs:unit_scale_for` | none (curve mode only) |
| `wadPerScaledUnit` | `vault.rs:wad_per_scaled_unit` | Stage 1's `WAD` |
| `scaledCapWad` | `vault.rs:scaled_cap_wad` | Stage 1's `cap × WAD` (`capEffWad(cap, 0)`) |
| `scaledAmount` | `vault.rs:scaled_amount` | Stage 1's `P_redeem × units` (`redemptionQuote`'s deposit) |
| `isCappedScaled` | `vault.rs:is_capped` | Stage 1's `isCapped` |
| `vaultReceiveGrossScaled` | `vault.rs:receive_capped`, `vault.rs:distribute`, `vault.rs:scaled_cap_wad` | Stage 1's `vaultReceiveGross` |
| `tailReceiveScaled` | `vault.rs:receive_capped`, `vault.rs:scaled_cap_wad` | Stage 1's `tailReceive` |
| `capRemainingScaled` | `redemption.rs:redemption_price` | Stage 1's `redemptionQuote(…).cRemaining` (our `capRemaining`) |
| `redemptionQuoteScaled` | `redemption.rs:redemption_price`, `vault.rs:scaled_amount` | Stage 1's `redemptionQuote` |
| `p0PerUnit` | `curve.rs:p0_per_unit` | none (curve mode only) |
| `swapBaseMatchesOffer` | `curve.rs:swap_base_matches_offer` | none (curve mode only) |
| `unitsOutstanding` | `curve.rs:units_outstanding` | none (curve mode only) |
| `migrationFeeSplit` | `curve.rs:migration_fee_split` | none (curve mode only) |
| `walletTenderFits` | `curve.rs:wallet_tender_fits` | none (curve mode only) |

## The curve-port gate

Every `stage1:sync` runs the ported family above against Stage 1 itself (step `curve-port`, `packages/stage1-sync/src/steps/curve-port.ts`) and fails the sync on any disagreement: Stage 1's figures, one table with a citation per row (`curve-port/figures.ts`), and Stage 1's Rust, merces-common built into a small oracle (`tools/stage1-oracle`) that answers a deterministic corpus case by case, refusals included. No cargo is a failure, not a skip.

Result at this checkout: **ok**. ported curve family agrees with Stage 1: 55/55 figures, 5,883/5,883 oracle cases against merces-common.

- Stage 1's figures: 55/55 rows agree (`curve_config.json` `expected` and `pdaCreator`, `curve_reports.json`, merces-common's `curve.rs`, `vault.rs` and `redemption.rs` tests, `curve_mode.rs`), every citation holding.
- Stage 1's Rust: 5,883/5,883 oracle cases agree exactly (corpus `16cc3a8ee31080c6`, seed `0x5747415445`), built with rustc 1.97.1 (8bab26f4f 2026-07-14), Stage 1's pin 1.97.1.

| Oracle entry point | Answers for | Cases | Agree |
| --- | --- | --- | --- |
| `constants` | `CURVE_BASE_DECIMALS`, `CURVE_UNIT_SCALE` | 1 | 1 |
| `unit_scale_for` | `unitScaleFor` | 256 | 256 |
| `wad_per_scaled_unit` | `wadPerScaledUnit` | 154 | 154 |
| `scaled_cap_wad` | `scaledCapWad` | 336 | 336 |
| `scaled_amount` | `scaledAmount` | 364 | 364 |
| `is_capped` | `isCappedScaled` | 254 | 254 |
| `receive_gross` | `vaultReceiveGrossScaled` | 1,213 | 1,213 |
| `receive_tail` | `tailReceiveScaled` | 602 | 602 |
| `cap_remaining` | `capRemainingScaled` | 255 | 255 |
| `redemption_price` | `redemptionQuoteScaled` | 822 | 822 |
| `p0_per_unit` | `p0PerUnit` | 356 | 356 |
| `swap_base_matches_offer` | `swapBaseMatchesOffer` | 285 | 285 |
| `units_outstanding` | `unitsOutstanding` | 288 | 288 |
| `migration_fee_split` | `migrationFeeSplit` | 411 | 411 |
| `wallet_tender_fits` | `walletTenderFits` | 286 | 286 |

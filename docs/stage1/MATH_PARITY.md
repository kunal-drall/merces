# MATH_PARITY.md

Stage 1 math imported at 1bfc66b; interim families remaining: FX (S5), window and curve cap (S5).

- Stage 1 math package: packages/reference at 1bfc66b.
- `@merces/math` re-exports 45 Stage 1 reference names (status, vault, redemption, treasury, income, auction); 45 are Stage 1's own objects. It also re-exports `@merces/sdk`'s fixed point, periods, pauses, year ring, parameters and error names.
- No function-by-function comparison: the gateway runs Stage 1's functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file's git history.
- The interim (Part C) math survives only under `interim.*`: since S2, only the window and curve cap (S5) and the FX family (S5); the sealed-bid auction runs Stage 1's auction family. Any other name there is reported as unclassified.

| Interim family | Names still exported under `interim` |
| --- | --- |
| FX (S5) | `quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`, `pythToWad` |
| window and curve cap (S5) | `walletCapUnits` |

## Ported from Stage 1's Rust (A-MATH-3)

Stage 1's TypeScript has no `unit_scale` and no curve code, so `@merces/math` ports 16 names from merces-common (`solana/crates/merces-common/src`) @1bfc66b, kept apart from the re-exports. They are not Stage 1 objects. At scale 1 each scale-aware one returns Stage 1's own TypeScript function's result (it calls it), so a sealed-bid series runs only Stage 1's functions; `packages/math/test/curve.test.ts` checks that on seeded grids and pins every figure of Stage 1's Rust tests and curve fixtures. This step checks each Rust item still exists at the checkout and is unchanged since the port (fingerprint). Stage 1 is asked to add `unit_scale` to its TypeScript so these become imports.

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

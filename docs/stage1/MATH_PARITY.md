# MATH_PARITY.md

Stage 1 math imported at 1bfc66b; interim families remaining: FX (S5), auction (S2).

- Stage 1 math package: packages/reference at 1bfc66b.
- `@merces/math` re-exports 34 Stage 1 reference names (status, vault, redemption, treasury, income); 34 are Stage 1's own objects. It also re-exports `@merces/sdk`'s fixed point, periods, pauses, year ring, parameters and error names.
- No function-by-function comparison: the gateway runs Stage 1's functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file's git history.
- The interim (Part C) math survives only under `interim.*`: since S1, only the auction family (S2) and the FX family (S5). Any other name there is reported as unclassified.

| Interim family | Names still exported under `interim` |
| --- | --- |
| FX (S5) | `quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`, `pythToWad` |
| auction (S2) | `clearAuction`, `walletCapUnits`, `bidDeposit`, `auctionFee` |

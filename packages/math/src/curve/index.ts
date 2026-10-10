/**
 * Curve and unit-scale math, ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3). These are not Stage 1
 * objects: Stage 1's TypeScript reference has no `unit_scale` and no curve code. At scale 1 every scale-aware function
 * returns what Stage 1's own TypeScript function returns (it calls it), so a sealed-bid series runs only Stage 1's
 * functions. `stage1:sync`'s math step lists these names as ported (`PORTED`) and checks each Rust source at the pin.
 */
export { CURVE_BASE_DECIMALS, CURVE_UNIT_SCALE, unitScaleFor, wadPerScaledUnit, scaledCapWad, scaledAmount } from './scale.ts';
export { isCappedScaled, vaultReceiveGrossScaled, tailReceiveScaled } from './vault.ts';
export { capRemainingScaled, redemptionQuoteScaled, type RedemptionInputsScaled } from './redemption.ts';
export { p0PerUnit, swapBaseMatchesOffer, unitsOutstanding, migrationFeeSplit, walletTenderFits, type MigrationFeeSplit } from './curve.ts';

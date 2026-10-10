/**
 * The interim Merces math (Part C) that outlives S2, reached as `interim.<name>` from `@merces/math`.
 *
 * Exactly two families remain, each until S5 moves its callers to Stage 1: the window and curve cap (`walletCapUnits`;
 * Stage 1's window semantics) and the FX family (Stage 1's FX accumulator). Everything else moved to Stage 1's own
 * functions: S1 the period, payout, status, redemption, tail, final-pool and window-escrow math, S2 the sealed-bid
 * auction (Stage 1's multi-step settlement, re-exported from `@merces/math`). The test in
 * `packages/math/test/math.test.ts` pins this key list. Nothing here is Stage 1's semantics: the interim
 * `walletCapUnits` rounds up to one unit where Stage 1's caps do not.
 */
export { walletCapUnits } from './cap.ts';
export { quarterAverageRate, coverageOk, deviationBps, withinBand, pythToWad } from './fx.ts';

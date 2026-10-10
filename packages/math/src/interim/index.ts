/**
 * The interim Merces math (Part C) that outlives S1, reached as `interim.<name>` from `@merces/math`.
 *
 * Exactly two families remain, each until its milestone moves the callers to Stage 1: the auction family (S2: Stage 1's
 * multi-step settlement) and the FX family (S5: Stage 1's FX accumulator). Everything else moved to Stage 1's own
 * functions during S1; the test in `packages/math/test/math.test.ts` pins this key list. Nothing here is Stage 1's
 * semantics: the interim `walletCapUnits` rounds up to one unit where Stage 1's `walletCapUnitsAtAuction` (re-exported
 * from `@merces/math` since S2 WP1) does not, and the interim clearing trims an over-cap bid where Stage 1 invalidates it.
 */
export { clearAuction, walletCapUnits, auctionFee, bidDeposit, type RevealedBid, type Allocation, type ClearingResult } from './auction.ts';
export { quarterAverageRate, coverageOk, deviationBps, withinBand, pythToWad } from './fx.ts';

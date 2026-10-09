/**
 * The interim Merces math (Part C), kept only until each caller moves to Stage 1's functions.
 *
 * Reached as `interim.<name>` from `@merces/math`. Every work package removes the `interim.` uses in the files it
 * owns; at the end of S1 only the auction family (S2) and the FX family (S5) remain. Nothing here is Stage 1's
 * semantics: where a Stage 1 function of the same name exists (`hurdlePrice`, `redemptionQuote`, `lateAccrual`,
 * `owedYtd`, `quarterPayment`, `walletCapUnits`, `capRemaining`), it differs in signature, rounding or meaning.
 */
export * from './fixed.ts';
export * from './time.ts';
export * from './payment.ts';
export * from './fees.ts';
export * from './cap.ts';
export * from './redemption.ts';
export * from './lateness.ts';
export * from './fx.ts';
export * from './auction.ts';

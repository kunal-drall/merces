import { DEFAULT_PARAMETERS, wadFromDecimal } from '@merces/math';

/**
 * OWNER HOLD (S2 amendment M1): the non-reveal charge is not modelled. Stage 1 keeps `floor(escrow × bps / 10000)` of an
 * unrevealed bid's escrow when the raise settles (SPEC §5.2, `processBid`; 1% by default). The owner asked to be told
 * what Stage 1 does before it is modelled, so while this is `true`:
 *  - new series record 0 bps (`DEFAULTS.nonRevealChargeBps`), live series included: a charter is frozen at creation, so
 *    a live series created during the hold keeps 0 after the hold is lifted (lifting changes new series only);
 *  - settlement applies 0 bps whatever a series records (`appliedNonRevealChargeBps`), so an unrevealed bid is refunded
 *    in full;
 *  - nothing else exists for the charge: no event, fee kind, column, accounting row or API field.
 * Lifting the hold is a separate change (STAGE1_INTEGRATION.md divergence register, ASSUMPTIONS.md A-AUC-11).
 *
 * Declared above `DEFAULTS`, which reads it at module initialisation.
 */
export const NON_REVEAL_CHARGE_HELD = true;

/** The non-reveal charge the engine applies for a series recording `termsBps`: 0 while the charge is held. */
export function appliedNonRevealChargeBps(termsBps: number): number {
  return NON_REVEAL_CHARGE_HELD ? 0 : termsBps;
}

/**
 * Protocol defaults (B8). Every default is a parameter, never a constant baked into logic (B11):
 * series carry their own copy of each value at creation. Where Stage 1 fixes a default (`DEFAULT_PARAMETERS`,
 * SPEC §1.6), it is taken from Stage 1 rather than restated. The bounds are Stage 1's `PARAMETER_BOUNDS`, applied by
 * `seriesTermsViolations` (terms-rules.ts).
 */
export const DEFAULTS = {
  capMultipleWad: wadFromDecimal('2.5'),
  hurdleWad: wadFromDecimal('0.08'),
  payoutMultipleK: 5,
  /** 18 × 30.4375 days = 47,336,400 s (Stage 1 `EIGHTEEN_MONTHS_SECONDS`; was 540 days, A-TERMS-2) */
  lockupSeconds: Number(DEFAULT_PARAMETERS.lockupSeconds),
  auctionFeeBps: 100,
  payoutFeeBps: 500,
  walletCapBps: 1_000,
  /**
   * 0 while the non-reveal charge is held (`NON_REVEAL_CHARGE_HELD`; Stage 1's default is 100 bps). Every series created
   * during the hold records 0, live series included, and keeps it: charters are frozen.
   */
  nonRevealChargeBps: NON_REVEAL_CHARGE_HELD ? 0 : DEFAULT_PARAMETERS.nonRevealChargeBps,
  /** The sealed-bid raise's commit and reveal phases (Stage 1 `commit_duration` 7 days, `reveal_duration` 2 days). */
  commitDurationSeconds: Number(DEFAULT_PARAMETERS.commitDuration),
  revealDurationSeconds: Number(DEFAULT_PARAMETERS.revealDuration),
  dueDays: 30,
  graceDays: 15,
  formalNoticeDays: 90,
  minCoverageBps: 8_000,
  /** Pyth vs Chainlink deviation band — placeholder until Kunal sets it (Part J.8); Stage 1's default is 200 (FX moves in S5). */
  fxDeviationBandBps: 100,
  maxRateAgeSeconds: 3_600,
  /** The tail clause runs this long after redemption (Stage 1: one 365-day year, min = max). */
  tailSeconds: Number(DEFAULT_PARAMETERS.tailSeconds),
  trueUpDays: 60,
  /** Hardship-pause bounds (Stage 1 `approve_pause`, SPEC §6.4). */
  maxPauseSeconds: Number(DEFAULT_PARAMETERS.maxPauseSeconds),
  maxCumulativePauseSeconds: Number(DEFAULT_PARAMETERS.maxCumulativePauseSeconds),
  maxPauses: DEFAULT_PARAMETERS.maxPauses,
} as const;

export const STABLECOIN_DECIMALS = 6;

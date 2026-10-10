import { DEFAULT_PARAMETERS, wadFromDecimal } from '@merces/math';

/**
 * Protocol defaults (B8). Every default is a parameter, never a constant baked into logic (B11):
 * series carry their own copy of each value at creation. Where Stage 1 fixes a default (`DEFAULT_PARAMETERS`,
 * SPEC §1.6), it is taken from Stage 1 rather than restated.
 */
export const DEFAULTS = {
  capMultipleWad: wadFromDecimal('2.5'),
  capMultipleMinWad: wadFromDecimal('2.0'),
  capMultipleMaxWad: wadFromDecimal('3.0'),
  hurdleWad: wadFromDecimal('0.08'),
  payoutMultipleK: 5,
  /** 18 × 30.4375 days = 47,336,400 s (Stage 1 `EIGHTEEN_MONTHS_SECONDS`; was 540 days, A-TERMS-2) */
  lockupSeconds: Number(DEFAULT_PARAMETERS.lockupSeconds),
  auctionFeeBps: 100,
  payoutFeeBps: 500,
  walletCapBps: 1_000,
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

import { wadFromDecimal } from '@merces/math';

/**
 * Protocol defaults (B8). Every default is a parameter, never a constant baked into logic (B11):
 * series carry their own copy of each value at creation.
 */
export const DEFAULTS = {
  capMultipleWad: wadFromDecimal('2.5'),
  capMultipleMinWad: wadFromDecimal('2.0'),
  capMultipleMaxWad: wadFromDecimal('3.0'),
  hurdleWad: wadFromDecimal('0.08'),
  payoutMultipleK: 5,
  lockupSeconds: 18 * 30 * 86_400, // 18 months, 30-day months (A-TERMS-2)
  auctionFeeBps: 100,
  payoutFeeBps: 500,
  walletCapBps: 1_000,
  dueDays: 30,
  graceDays: 15,
  formalNoticeDays: 90,
  minCoverageBps: 8_000,
  /** Pyth vs Chainlink deviation band — placeholder until Kunal sets it (Part J.8). */
  fxDeviationBandBps: 100,
  maxRateAgeSeconds: 3_600,
  tailMonths: 12,
  trueUpDays: 60,
} as const;

export const STABLECOIN_DECIMALS = 6;

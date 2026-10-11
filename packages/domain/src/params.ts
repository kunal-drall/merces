import { DEFAULT_PARAMETERS, PARAMETER_BOUNDS, wadFromDecimal } from '@merces/math';

/**
 * The non-reveal charge (SPEC §5.2), modelled as Stage 1's code does: a per-series term, `SeriesTerms.nonRevealChargeBps`,
 * frozen at creation and bounded to Stage 1's `PARAMETER_BOUNDS.nonRevealChargeBps` (0–1,000 bps). When a sealed raise
 * settles, Stage 1's `processBid` keeps `floor(escrow × bps / 10000)` of a bid that was committed and never revealed and
 * pays it to the protocol fee collector at `process_bid`; the rest of the escrow is the bid's refund, paid at
 * `deliver_bid`. A failed raise refunds every bid in full, and a revealed bid (valid or not) is never charged.
 *
 * There is no built-in rate. Stage 1's chains copy the rate into each series from the protocol defaults the admin sets
 * (`set_defaults`; Solana `merces_registry` lib.rs:550, EVM `MercesRegistry.sol:597`), and issuers cannot choose it.
 * Ours: new series built through the terms service take the owner's deployment setting `MERCES_NON_REVEAL_CHARGE_BPS`
 * (`nonRevealChargeSetting`); while it is unset, no sealed series is built (409). Tests, the harness and the vector
 * runner pass explicit values.
 */
export const NON_REVEAL_CHARGE_SETTING = 'MERCES_NON_REVEAL_CHARGE_BPS';

/** Stage 1's bounds on the non-reveal charge, in bps (`PARAMETER_BOUNDS.nonRevealChargeBps`). */
export const NON_REVEAL_CHARGE_BOUNDS = { min: Number(PARAMETER_BOUNDS.nonRevealChargeBps.min), max: Number(PARAMETER_BOUNDS.nonRevealChargeBps.max) } as const;

/**
 * The owner's non-reveal charge for new series, from `MERCES_NON_REVEAL_CHARGE_BPS`: an integer number of bps within
 * Stage 1's bounds, or null while the setting is unset (absent or blank). Any other value throws at startup; the message
 * names the setting and the bounds, never the value given.
 */
export function nonRevealChargeSetting(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = env[NON_REVEAL_CHARGE_SETTING]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${NON_REVEAL_CHARGE_SETTING} must be a whole number of bps between ${NON_REVEAL_CHARGE_BOUNDS.min} and ${NON_REVEAL_CHARGE_BOUNDS.max} (Stage 1's bounds)`);
  return checkNonRevealCharge(Number(raw));
}

/** A non-reveal charge within Stage 1's bounds, returned as given; anything else throws (value-free). */
export function checkNonRevealCharge(bps: number): number {
  if (!Number.isInteger(bps) || bps < NON_REVEAL_CHARGE_BOUNDS.min || bps > NON_REVEAL_CHARGE_BOUNDS.max) {
    throw new Error(`${NON_REVEAL_CHARGE_SETTING} must be a whole number of bps between ${NON_REVEAL_CHARGE_BOUNDS.min} and ${NON_REVEAL_CHARGE_BOUNDS.max} (Stage 1's bounds)`);
  }
  return bps;
}

/**
 * Protocol defaults (B8). Every default is a parameter, never a constant baked into logic (B11):
 * series carry their own copy of each value at creation. Where Stage 1 fixes a default (`DEFAULT_PARAMETERS`,
 * SPEC §1.6), it is taken from Stage 1 rather than restated. The bounds are Stage 1's `PARAMETER_BOUNDS`, applied by
 * `seriesTermsViolations` (terms-rules.ts). The non-reveal charge has no default here: it is the owner's setting
 * (`NON_REVEAL_CHARGE_SETTING`).
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
  /** The sealed-bid raise's commit and reveal phases (Stage 1 `commit_duration` 7 days, `reveal_duration` 2 days). */
  commitDurationSeconds: Number(DEFAULT_PARAMETERS.commitDuration),
  revealDurationSeconds: Number(DEFAULT_PARAMETERS.revealDuration),
  windowCommitDuration: Number(DEFAULT_PARAMETERS.windowCommitDuration),
  windowRevealDuration: Number(DEFAULT_PARAMETERS.windowRevealDuration),
  windowFeeBps: DEFAULT_PARAMETERS.windowFeeBps,
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

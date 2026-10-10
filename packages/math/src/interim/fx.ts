import { BPS_DENOMINATOR as BPS } from '@merces/sdk';

/**
 * The interim FX family (S5 replaces it with Stage 1's trading-day coverage and FX accumulator).
 *
 * C9. Rate accumulator: one snapshot per UTC day per pair; running sum and count.
 * fx_avg(q) = (sum_end − sum_start) / (count_end − count_start)
 */
const DEFAULT_MIN_COVERAGE_BPS = 8_000n; // 80% of the quarter's days

export function quarterAverageRate(sumEnd: bigint, sumStart: bigint, countEnd: number, countStart: number): bigint {
  const n = BigInt(countEnd - countStart);
  if (n <= 0n) throw new RangeError('no snapshots in the quarter');
  const s = sumEnd - sumStart;
  if (s < 0n) throw new RangeError('rate sum must be non-negative');
  return s / n;
}

export function coverageOk(snapshots: number, daysInQuarter: number, minCoverageBps: bigint = DEFAULT_MIN_COVERAGE_BPS): boolean {
  if (daysInQuarter <= 0) return false;
  return BigInt(snapshots) * BPS >= BigInt(daysInQuarter) * minCoverageBps;
}

/** |a − b| / b in basis points (b is the reference, e.g. the Chainlink rate). */
export function deviationBps(a: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new RangeError('reference must be positive');
  const diff = a > reference ? a - reference : reference - a;
  return (diff * BPS) / reference;
}

export function withinBand(a: bigint, reference: bigint, bandBps: bigint): boolean {
  return deviationBps(a, reference) <= bandBps;
}

/** Convert a Pyth-style (price, expo) into a WAD rate. price × 10^expo × 1e18, floored. */
export function pythToWad(price: bigint, expo: number): bigint {
  if (expo >= 0) return price * 10n ** BigInt(expo) * 10n ** 18n;
  const scale = 10n ** BigInt(-expo);
  return (price * 10n ** 18n) / scale;
}

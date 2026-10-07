/**
 * Rate accumulator (SPEC §6.6, brief C9): daily Pyth snapshots, period checkpoints, coverage and
 * deviation checks, quarter averages.
 */
import { BPS_DENOMINATOR, DAY, WAD, daysInPeriod, mulDiv, periodOf } from "@merces/sdk";

export interface FxCheckpoint {
  sumWad: bigint;
  count: number;
  flagged: boolean;
}

export interface FxPairState {
  sumWad: bigint;
  count: number;
  /** last snapshot day (`now / DAY`), −1 when none */
  lastDay: bigint;
  checkpoints: Map<number, FxCheckpoint>;
}

export function newFxPairState(): FxPairState {
  return { sumWad: 0n, count: 0, lastDay: -1n, checkpoints: new Map() };
}

export interface PythPrice {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
}

export interface FxParams {
  fxMaxStalenessSeconds: bigint;
  fxMaxConfBps: number;
  fxDeviationBandBps: number;
  fxMinCoverageBps: number;
}

/** `rate_wad = price × 10^(18 + expo)` (floor when the exponent would be negative). */
export function normalizePythPrice(price: bigint, expo: number): bigint {
  if (price <= 0n) throw new RangeError("price must be > 0");
  if (!Number.isInteger(expo)) throw new RangeError("expo must be an integer");
  const e = 18 + expo;
  return e >= 0 ? price * 10n ** BigInt(e) : price / 10n ** BigInt(-e);
}

/** `rate_wad = floor(WAD × WAD / rate_wad)` */
export function invertRate(rateWad: bigint): bigint {
  if (rateWad <= 0n) throw new RangeError("rate must be > 0");
  return (WAD * WAD) / rateWad;
}

/** Returns the rejection reason, or null when the update is acceptable. */
export function validatePythPrice(p: PythPrice, now: bigint, params: Pick<FxParams, "fxMaxStalenessSeconds" | "fxMaxConfBps">): string | null {
  if (p.price <= 0n) return "NonPositivePrice";
  if (p.publishTime < now - params.fxMaxStalenessSeconds) return "StalePrice";
  if (p.conf * BPS_DENOMINATOR > p.price * BigInt(params.fxMaxConfBps)) return "ConfidenceTooWide";
  return null;
}

/** `|rate − cl| × 10000 > cl × band_bps` */
export function deviates(rateWad: bigint, crosscheckWad: bigint, bandBps: number): boolean {
  const diff = rateWad > crosscheckWad ? rateWad - crosscheckWad : crosscheckWad - rateWad;
  return diff * BPS_DENOMINATOR > crosscheckWad * BigInt(bandBps);
}

export interface SnapshotResult {
  state: FxPairState;
  day: bigint;
  period: number;
  rateWad: bigint;
  flagged: boolean;
  /** true when this snapshot opened a new period checkpoint */
  checkpointed: boolean;
}

/**
 * One daily snapshot with an already validated and normalized `rateWad` (inversion applied by
 * the caller). Throws `SnapshotAlreadyTaken` for a second snapshot on the same UTC day.
 */
export function snapshot(state: FxPairState, now: bigint, rateWad: bigint, crosscheckWad: bigint | null, params: Pick<FxParams, "fxDeviationBandBps">): SnapshotResult {
  const day = now / DAY;
  if (day <= state.lastDay) throw new Error("SnapshotAlreadyTaken");
  const period = periodOf(now);
  const checkpoints = new Map(state.checkpoints);
  let checkpointed = false;
  if (!checkpoints.has(period)) {
    checkpoints.set(period, { sumWad: state.sumWad, count: state.count, flagged: false });
    checkpointed = true;
  }
  let flagged = false;
  if (crosscheckWad !== null && deviates(rateWad, crosscheckWad, params.fxDeviationBandBps)) {
    const cp = checkpoints.get(period)!;
    checkpoints.set(period, { ...cp, flagged: true });
    flagged = true;
  }
  return {
    state: { sumWad: state.sumWad + rateWad, count: state.count + 1, lastDay: day, checkpoints },
    day,
    period,
    rateWad,
    flagged,
    checkpointed,
  };
}

export type QuarterAverage = { ok: true; avgWad: bigint; n: number; flagged: false } | { ok: false; reason: "NeedsFallback"; avgWad: bigint | null; n: number; flagged: boolean };

/**
 * `quarter_average(pair, p)`: needs checkpoints `p` and `p+1`; `n = count_{p+1} − count_p`;
 * `ok = n × 10000 ≥ days_in_period(p) × min_coverage_bps && !flagged_p`; `avg = floor(Δsum / n)`.
 */
export function quarterAverage(state: FxPairState, period: number, params: Pick<FxParams, "fxMinCoverageBps">): QuarterAverage {
  const a = state.checkpoints.get(period);
  const b = state.checkpoints.get(period + 1);
  if (!a || !b) return { ok: false, reason: "NeedsFallback", avgWad: null, n: 0, flagged: a?.flagged ?? false };
  const n = b.count - a.count;
  const avgWad = n > 0 ? (b.sumWad - a.sumWad) / BigInt(n) : null;
  const covered = BigInt(n) * BPS_DENOMINATOR >= daysInPeriod(period) * BigInt(params.fxMinCoverageBps);
  if (covered && !a.flagged && avgWad !== null) return { ok: true, avgWad, n, flagged: false };
  return { ok: false, reason: "NeedsFallback", avgWad, n, flagged: a.flagged };
}

/** Number of daily snapshots needed for coverage in a period. */
export function snapshotsNeeded(period: number, minCoverageBps: number): number {
  const need = daysInPeriod(period) * BigInt(minCoverageBps);
  let n = need / BPS_DENOMINATOR;
  if (n * BPS_DENOMINATOR < need) n += 1n;
  return Number(n);
}

export { mulDiv };

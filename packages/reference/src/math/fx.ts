/**
 * Rate accumulator (SPEC v1.1 §6.6, brief C9): daily snapshots, period checkpoints, deviation
 * flags, trading-day coverage and the live end checkpoint.
 */
import { BPS_DENOMINATOR, DAY, periodOf, periodStart, periodEnd, tradingDaysInPeriod, invertRate, normalizePythPrice } from "@merces/sdk";

export { invertRate, normalizePythPrice };

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

/** Returns the rejection reason, or null when the update is acceptable. */
export function validatePythPrice(p: PythPrice, now: bigint, params: Pick<FxParams, "fxMaxStalenessSeconds" | "fxMaxConfBps">): "NonPositivePrice" | "StalePrice" | "ConfidenceTooWide" | null {
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
  checkpointed: boolean;
}

/**
 * One daily snapshot with a validated, normalized (and inverted if configured) `rateWad`.
 * `crosscheckWad` is applied only when the pair's cross-check is effective for the period
 * (`period_of(now) ≥ crosscheck_effective_period`); pass null otherwise.
 * Throws `SnapshotAlreadyTaken` for a second snapshot on the same UTC day.
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
  return { state: { sumWad: state.sumWad + rateWad, count: state.count + 1, lastDay: day, checkpoints }, day, period, rateWad, flagged, checkpointed };
}

export type QuarterAverage =
  | { ok: true; avgWad: bigint; n: number; flagged: false; liveEnd: boolean }
  | { ok: false; reason: "NeedsFallback"; avgWad: bigint | null; n: number; flagged: boolean; liveEnd: boolean };

/**
 * `quarter_average(pair, p)` at time `now`: start = checkpoint `p` (required); end = checkpoint
 * `p+1` if present, else the live totals when `now ≥ period_end(p)` and no snapshot has yet been
 * taken in `p+1` (`last_day × DAY < period_start(p+1)`); otherwise NeedsFallback.
 * `ok = n × 10000 ≥ trading_days_in_period(p) × fx_min_coverage_bps && !flagged_p`.
 */
export function quarterAverage(state: FxPairState, period: number, params: Pick<FxParams, "fxMinCoverageBps">, now: bigint): QuarterAverage {
  const start = state.checkpoints.get(period);
  if (!start) return { ok: false, reason: "NeedsFallback", avgWad: null, n: 0, flagged: false, liveEnd: false };
  let end: FxCheckpoint | undefined = state.checkpoints.get(period + 1);
  let liveEnd = false;
  if (!end) {
    if (now >= periodEnd(period) && state.lastDay * DAY < periodStart(period + 1)) {
      end = { sumWad: state.sumWad, count: state.count, flagged: false };
      liveEnd = true;
    } else {
      return { ok: false, reason: "NeedsFallback", avgWad: null, n: 0, flagged: start.flagged, liveEnd: false };
    }
  }
  const n = end.count - start.count;
  const avgWad = n > 0 ? (end.sumWad - start.sumWad) / BigInt(n) : null;
  const covered = BigInt(n) * BPS_DENOMINATOR >= tradingDaysInPeriod(period) * BigInt(params.fxMinCoverageBps);
  if (covered && !start.flagged && avgWad !== null) return { ok: true, avgWad, n, flagged: false, liveEnd };
  return { ok: false, reason: "NeedsFallback", avgWad, n, flagged: start.flagged, liveEnd };
}

/** Number of daily snapshots needed for coverage in a period (over trading days). */
export function snapshotsNeeded(period: number, minCoverageBps: number): number {
  const need = tradingDaysInPeriod(period) * BigInt(minCoverageBps);
  let n = need / BPS_DENOMINATOR;
  if (n * BPS_DENOMINATOR < need) n += 1n;
  return Number(n);
}

/**
 * Status derivation, deadlines, effective clock and late accrual (SPEC §6.4, brief C8).
 */
import { DAY, WAD, SeriesStatus, periodEnd } from "@merces/sdk";

export interface StatusParams {
  reportDueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  hurdleRateWad: bigint;
}

export interface LedgerClock {
  /** stored terminal status or a derived one; only terminal values matter here */
  status: SeriesStatus;
  firstPeriod: number;
  lastAcceptedPeriod: number | null;
  openDuePeriod: number | null;
  openDueAmount: bigint;
  pauseStart: bigint;
  pauseEnd: bigint;
  pausedTotal: bigint;
}

export function isTerminal(status: SeriesStatus): boolean {
  return status === SeriesStatus.Retired || status === SeriesStatus.Redeemed || status === SeriesStatus.Extinguished;
}

/** `pause_elapsed(now) = pause_start == 0 ? 0 : min(now, pause_end) − pause_start` */
export function pauseElapsed(c: Pick<LedgerClock, "pauseStart" | "pauseEnd">, now: bigint): bigint {
  if (c.pauseStart === 0n) return 0n;
  const until = now < c.pauseEnd ? now : c.pauseEnd;
  return until > c.pauseStart ? until - c.pauseStart : 0n;
}

/** `effective_now(now) = now − paused_total − pause_elapsed(now)` */
export function effectiveNow(c: Pick<LedgerClock, "pauseStart" | "pauseEnd" | "pausedTotal">, now: bigint): bigint {
  return now - c.pausedTotal - pauseElapsed(c, now);
}

/** `is_paused(now) = pause_start != 0 && now < pause_end` */
export function isPaused(c: Pick<LedgerClock, "pauseStart" | "pauseEnd">, now: bigint): boolean {
  return c.pauseStart !== 0n && now < c.pauseEnd;
}

/** `deadline(p) = period_end(p) + report_due_days × DAY` */
export function deadline(period: number, p: Pick<StatusParams, "reportDueDays">): bigint {
  return periodEnd(period) + BigInt(p.reportDueDays) * DAY;
}

/** `grace_end(p) = deadline(p) + grace_days × DAY` */
export function graceEnd(period: number, p: Pick<StatusParams, "reportDueDays" | "graceDays">): bigint {
  return deadline(period, p) + BigInt(p.graceDays) * DAY;
}

/** next expected period: `first_period` if none accepted else `last_accepted_period + 1` */
export function nextExpectedPeriod(c: Pick<LedgerClock, "firstPeriod" | "lastAcceptedPeriod">): number {
  return c.lastAcceptedPeriod === null ? c.firstPeriod : c.lastAcceptedPeriod + 1;
}

/** `earliest_unpaid() = open_due_period if open_due_amount > 0 else next expected period` */
export function earliestUnpaid(c: LedgerClock): number {
  return c.openDueAmount > 0n && c.openDuePeriod !== null ? c.openDuePeriod : nextExpectedPeriod(c);
}

export function deriveStatus(c: LedgerClock, now: bigint, p: StatusParams): SeriesStatus {
  if (isTerminal(c.status)) return c.status;
  if (isPaused(c, now)) return SeriesStatus.Paused;
  const period = earliestUnpaid(c);
  const e = effectiveNow(c, now);
  if (e <= deadline(period, p)) return SeriesStatus.OnTime;
  if (e <= graceEnd(period, p)) return SeriesStatus.InGrace;
  return SeriesStatus.Late;
}

/** `late_days(p, now) = max(0, floor((effective_now(now) − grace_end(p)) / DAY))` */
export function lateDays(period: number, c: LedgerClock, now: bigint, p: StatusParams): bigint {
  const e = effectiveNow(c, now);
  const g = graceEnd(period, p);
  return e > g ? (e - g) / DAY : 0n;
}

/** `late_accrual(p, amount, now) = floor(amount × hurdle_rate_wad × late_days / (365 × WAD))` */
export function lateAccrual(period: number, amount: bigint, c: LedgerClock, now: bigint, p: StatusParams): bigint {
  return (amount * p.hurdleRateWad * lateDays(period, c, now, p)) / (365n * WAD);
}

/** Accrual for a generic grace end (tier-3 true-up uses `grace_end := trueup_deadline`). */
export function accrualFromGraceEnd(amount: bigint, graceEndTs: bigint, c: LedgerClock, now: bigint, hurdleRateWad: bigint): bigint {
  const e = effectiveNow(c, now);
  const days = e > graceEndTs ? (e - graceEndTs) / DAY : 0n;
  return (amount * hurdleRateWad * days) / (365n * WAD);
}

/** `effective_now ≥ deadline(p) + formal_notice_days × DAY` */
export function formalNoticeDue(period: number, c: LedgerClock, now: bigint, p: StatusParams): boolean {
  return effectiveNow(c, now) >= deadline(period, p) + BigInt(p.formalNoticeDays) * DAY;
}

/**
 * `sync_status` pause bookkeeping: when a pause has ended (`pause_start != 0 && now ≥ pause_end`)
 * fold it into `paused_total` and clear it. Returns the updated clock fields.
 */
export function closeExpiredPause(c: LedgerClock, now: bigint): Pick<LedgerClock, "pauseStart" | "pauseEnd" | "pausedTotal"> {
  if (c.pauseStart !== 0n && now >= c.pauseEnd) {
    return { pauseStart: 0n, pauseEnd: 0n, pausedTotal: c.pausedTotal + (c.pauseEnd - c.pauseStart) };
  }
  return { pauseStart: c.pauseStart, pauseEnd: c.pauseEnd, pausedTotal: c.pausedTotal };
}

/**
 * Status derivation, deadlines and accrual (SPEC v1.1 §6.4): every countdown runs in unpaused
 * time from its own start over a bounded pause list; there is no global effective clock.
 */
import { DAY, WAD, SeriesStatus, mulDiv, periodEnd, unpaused, isPausedAt, type Pause } from "@merces/sdk";

export interface StatusParams {
  reportDueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  trueupDays: number;
  hurdleRateWad: bigint;
}

export interface LedgerClock {
  /** stored status; only terminal values matter for derivation */
  status: SeriesStatus;
  firstPeriod: number;
  lastAcceptedPeriod: number | null;
  openDuePeriod: number | null;
  openDueAmount: bigint;
  pauses: readonly Pause[];
  trueupDue: bigint;
  trueupAttestedAt: bigint;
}

export function isTerminal(status: SeriesStatus): boolean {
  return status === SeriesStatus.Retired || status === SeriesStatus.Redeemed || status === SeriesStatus.Extinguished;
}

export const deadlineSeconds = (p: Pick<StatusParams, "reportDueDays">): bigint => BigInt(p.reportDueDays) * DAY;
export const graceSeconds = (p: Pick<StatusParams, "reportDueDays" | "graceDays">): bigint => BigInt(p.reportDueDays + p.graceDays) * DAY;
export const noticeSeconds = (p: Pick<StatusParams, "formalNoticeDays">): bigint => BigInt(p.formalNoticeDays) * DAY;

/** `countdown(p, now) = unpaused(period_end(p), now)`; 0 before the period ends. */
export function countdown(period: number, c: Pick<LedgerClock, "pauses">, now: bigint): bigint {
  const start = periodEnd(period);
  return now <= start ? 0n : unpaused(c.pauses, start, now, now);
}

export function isPaused(c: Pick<LedgerClock, "pauses">, now: bigint): boolean {
  return isPausedAt(c.pauses, now);
}

/** next expected period: `first_period` if none accepted else `last_accepted_period + 1` */
export function nextExpectedPeriod(c: Pick<LedgerClock, "firstPeriod" | "lastAcceptedPeriod">): number {
  return c.lastAcceptedPeriod === null ? c.firstPeriod : c.lastAcceptedPeriod + 1;
}

/** `earliest_unpaid() = open_due_period if open_due_amount > 0 else next expected period` */
export function earliestUnpaid(c: LedgerClock): number {
  return c.openDueAmount > 0n && c.openDuePeriod !== null ? c.openDuePeriod : nextExpectedPeriod(c);
}

/** `trueup_overdue(now) = trueup_due > 0 && unpaused(trueup_attested_at, now) > trueup_days × DAY` */
export function trueupOverdue(c: Pick<LedgerClock, "pauses" | "trueupDue" | "trueupAttestedAt">, now: bigint, p: Pick<StatusParams, "trueupDays">): boolean {
  if (c.trueupDue === 0n) return false;
  if (now <= c.trueupAttestedAt) return false;
  return unpaused(c.pauses, c.trueupAttestedAt, now, now) > BigInt(p.trueupDays) * DAY;
}

export function deriveStatus(c: LedgerClock, now: bigint, p: StatusParams): SeriesStatus {
  if (isTerminal(c.status)) return c.status;
  if (isPaused(c, now)) return SeriesStatus.Paused;
  if (trueupOverdue(c, now, p)) return SeriesStatus.Late;
  const cd = countdown(earliestUnpaid(c), c, now);
  if (cd <= deadlineSeconds(p)) return SeriesStatus.OnTime;
  if (cd <= graceSeconds(p)) return SeriesStatus.InGrace;
  return SeriesStatus.Late;
}

/** `is_late_underlying(now)`: the Late test ignoring Paused (gates treasury releases). */
export function isLateUnderlying(c: LedgerClock, now: bigint, p: StatusParams): boolean {
  if (isTerminal(c.status)) return false;
  return trueupOverdue(c, now, p) || countdown(earliestUnpaid(c), c, now) > graceSeconds(p);
}

/** `late_days(p, now) = max(0, floor((countdown(p, now) − grace_s) / DAY))` */
export function lateDays(period: number, c: LedgerClock, now: bigint, p: StatusParams): bigint {
  const cd = countdown(period, c, now);
  const g = graceSeconds(p);
  return cd > g ? (cd - g) / DAY : 0n;
}

/** `late_accrual(p, amount, now) = mulDiv(mulDiv(amount, hurdle_rate_wad, WAD), late_days, 365)` */
export function lateAccrual(period: number, amount: bigint, c: LedgerClock, now: bigint, p: StatusParams): bigint {
  return mulDiv(mulDiv(amount, p.hurdleRateWad, WAD), lateDays(period, c, now, p), 365n);
}

/** `late_accrual_trueup(now) = mulDiv(mulDiv(trueup_due, h, WAD), max(0, floor((unpaused(attested_at, now) − trueup_days × DAY) / DAY)), 365)` */
export function lateAccrualTrueup(c: LedgerClock, now: bigint, p: StatusParams): bigint {
  if (c.trueupDue === 0n || now <= c.trueupAttestedAt) return 0n;
  const u = unpaused(c.pauses, c.trueupAttestedAt, now, now);
  const limit = BigInt(p.trueupDays) * DAY;
  const days = u > limit ? (u - limit) / DAY : 0n;
  return mulDiv(mulDiv(c.trueupDue, p.hurdleRateWad, WAD), days, 365n);
}

/** `FormalNoticeDue(series, p)` condition: `countdown(p, now) ≥ notice_s`. */
export function formalNoticeDue(period: number, c: LedgerClock, now: bigint, p: StatusParams): boolean {
  return countdown(period, c, now) >= noticeSeconds(p);
}

/** `FormalNoticeDue(series, trueup)`: `unpaused(attested_at, now) ≥ trueup_days × DAY + (notice_s − grace_s)`. */
export function trueupNoticeDue(c: LedgerClock, now: bigint, p: StatusParams): boolean {
  if (c.trueupDue === 0n || now <= c.trueupAttestedAt) return false;
  return unpaused(c.pauses, c.trueupAttestedAt, now, now) >= BigInt(p.trueupDays) * DAY + (noticeSeconds(p) - graceSeconds(p));
}

export interface PauseBounds {
  maxPauseSeconds: bigint;
  maxCumulativePauseSeconds: bigint;
  maxPauses: number;
}

/** `approve_pause` bounds (SPEC §6.4): returns the error name or null. `pausedTotal` is Σ approved lengths. */
export function pauseApprovalError(pauses: readonly Pause[], pausedTotal: bigint, now: bigint, pauseEnd: bigint, b: PauseBounds): "InvalidPauseEnd" | "AlreadyPaused" | "PauseTooLong" | "TooManyPauses" | null {
  if (pauseEnd <= now) return "InvalidPauseEnd";
  if (isPausedAt(pauses, now)) return "AlreadyPaused";
  if (pauseEnd - now > b.maxPauseSeconds) return "PauseTooLong";
  if (pausedTotal + (pauseEnd - now) > b.maxCumulativePauseSeconds) return "PauseTooLong";
  if (pauses.length >= b.maxPauses) return "TooManyPauses";
  return null;
}

import { WAD, assertNonNegative, mulDiv } from './fixed.ts';
import { DAY, type Period } from './time.ts';

/**
 * C8. Paying in, lateness and pauses.
 * 1. Due 30 days after the quarter ends. 2. 15-day grace. 3. After grace: simple interest at the hurdle
 * rate, payment × h × days_late / 365, added to the gross payment; releases pause. 4. Formal notice at 90 days.
 */
export const DEFAULT_DUE_DAYS = 30;
export const DEFAULT_GRACE_DAYS = 15;
export const DEFAULT_FORMAL_NOTICE_DAYS = 90;

export interface Deadlines {
  dueAt: number;
  graceEndsAt: number;
  formalNoticeAt: number;
}

/** Deadlines for a period, shifted by any paused seconds that overlapped the countdown. */
export function deadlinesFor(period: Period, opts: { dueDays?: number; graceDays?: number; formalNoticeDays?: number; pausedSeconds?: number } = {}): Deadlines {
  const dueDays = opts.dueDays ?? DEFAULT_DUE_DAYS;
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const noticeDays = opts.formalNoticeDays ?? DEFAULT_FORMAL_NOTICE_DAYS;
  const shift = opts.pausedSeconds ?? 0;
  const dueAt = period.end + dueDays * DAY + shift;
  return { dueAt, graceEndsAt: dueAt + graceDays * DAY, formalNoticeAt: dueAt + noticeDays * DAY };
}

/** Days late counted from the END of the grace period (assumption A-C8-1). */
export function daysLate(graceEndsAt: number, nowTs: number): number {
  return nowTs <= graceEndsAt ? 0 : Math.floor((nowTs - graceEndsAt) / DAY);
}

/** Simple-interest accrual: payment × h × days / 365, rounded down. */
export function lateAccrual(payment: bigint, hurdleWad: bigint, days: number): bigint {
  assertNonNegative(payment, 'payment');
  assertNonNegative(hurdleWad, 'hurdle');
  if (days <= 0) return 0n;
  return mulDiv(payment * hurdleWad, BigInt(days), WAD * 365n);
}

export type PeriodStanding = 'NotDue' | 'OnTime' | 'InGrace' | 'Late' | 'FormalNoticeDue';

export function periodStanding(d: Deadlines, nowTs: number, settled: boolean): PeriodStanding {
  if (settled) return 'OnTime';
  if (nowTs < d.dueAt) return 'NotDue';
  if (nowTs < d.graceEndsAt) return 'InGrace';
  if (nowTs < d.formalNoticeAt) return 'Late';
  return 'FormalNoticeDue';
}

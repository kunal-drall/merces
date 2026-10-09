/**
 * Status helpers on top of Stage 1's ledger clock (`@merces/reference` status.ts, SPEC v1.1 §6.4).
 *
 * Stage 1 decides every deadline by `countdown(pid, now) = unpaused(period_end(pid), now)` compared with
 * `deadlineSeconds` (≤ 30 days: OnTime), `graceSeconds` (≤ 45 days: InGrace) and `noticeSeconds` (≥ 90 days:
 * formal notice due). It has no function for the absolute instants; the API, the reminders and the keepers' cranks
 * need them, so `projectDeadlines` computes them from the same countdown. Property tests pin it to Stage 1's
 * `deriveStatus` and `formalNoticeDue` (packages/math/test/math.test.ts), so a change of origin or bound in Stage 1
 * cannot slip past.
 */
import { DEFAULT_PARAMETERS, isPausedAt, periodEnd, type Pause } from '@merces/sdk';
import { countdown, deadlineSeconds, formalNoticeDue, graceSeconds, noticeSeconds, type LedgerClock, type StatusParams } from '@merces/reference';

/** The lateness terms a series carries (simulator terms hold the hurdle as bigint, API terms as a decimal string). */
export interface StatusTerms {
  dueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  hurdleWad: bigint | string;
  /** Stage 1 fixes 60 days (min = max); defaults to `DEFAULT_PARAMETERS.trueupDays` */
  trueupDays?: number;
}

export function statusParamsOf(terms: StatusTerms): StatusParams {
  return {
    reportDueDays: terms.dueDays,
    graceDays: terms.graceDays,
    formalNoticeDays: terms.formalNoticeDays,
    trueupDays: terms.trueupDays ?? DEFAULT_PARAMETERS.trueupDays,
    hurdleRateWad: BigInt(terms.hurdleWad),
  };
}

export interface ProjectedDeadlines {
  /** last instant with `countdown ≤ deadlineSeconds` (OnTime); one second later the period is InGrace */
  dueAt: bigint;
  /** last instant with `countdown ≤ graceSeconds` (InGrace); one second later the period is Late */
  graceEndsAt: bigint;
  /** first instant with `countdown ≥ noticeSeconds` (`formalNoticeDue` turns true) */
  formalNoticeAt: bigint;
}

/**
 * First instant `t` at which `countdown(pid, t)` reaches `target` seconds, walking the pauses in order. Pauses are
 * taken as recorded, each to its recorded end (an open pause to its approved end); no later pause is assumed.
 * Stage 1 never records overlapping pauses (`AlreadyPaused`), so the countdown rises by one per unpaused second.
 */
function firstReach(from: bigint, pauses: readonly Pause[], target: bigint): bigint {
  let cur = from;
  let acc = 0n;
  const sorted = [...pauses].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (const p of sorted) {
    const s = p.start > from ? p.start : from;
    if (p.end <= s) continue;
    if (s > cur) {
      const run = s - cur;
      if (acc + run >= target) return cur + (target - acc);
      acc += run;
      cur = s;
    }
    if (p.end > cur) cur = p.end;
  }
  return cur + (target - acc);
}

/**
 * The instants at which period `pid`'s countdown passes Stage 1's three bounds, given the pauses recorded as of `now`
 * (a pause starting after `now` has not been approved yet and is ignored). Instants after `now` are projections:
 * a pause approved later moves them.
 */
export function projectDeadlines(pid: number, pauses: readonly Pause[], now: bigint, p: Pick<StatusParams, 'reportDueDays' | 'graceDays' | 'formalNoticeDays'>): ProjectedDeadlines {
  const from = periodEnd(pid);
  const known = pauses.filter((x) => x.start <= now);
  return {
    dueAt: firstReach(from, known, deadlineSeconds(p) + 1n) - 1n,
    graceEndsAt: firstReach(from, known, graceSeconds(p) + 1n) - 1n,
    formalNoticeAt: firstReach(from, known, noticeSeconds(p)),
  };
}

export type Standing = 'NotDue' | 'OnTime' | 'InGrace' | 'Late' | 'FormalNoticeDue' | 'Deferred';

/**
 * One period's standing at `now`, on Stage 1's bounds. `NotDue` labels a period that has not ended (Stage 1 counts
 * it OnTime); `Deferred` a period that is unsettled while a hardship pause is active; `FormalNoticeDue` a late period
 * whose countdown reached the notice bound (period end + 90 days of unpaused time).
 */
export function standingOf(pid: number, clock: LedgerClock, now: bigint, p: StatusParams, settled: boolean): Standing {
  if (settled) return 'OnTime';
  if (now < periodEnd(pid)) return 'NotDue';
  if (isPausedAt(clock.pauses, now)) return 'Deferred';
  if (formalNoticeDue(pid, clock, now, p)) return 'FormalNoticeDue';
  const cd = countdown(pid, clock, now);
  if (cd <= deadlineSeconds(p)) return 'OnTime';
  if (cd <= graceSeconds(p)) return 'InGrace';
  return 'Late';
}

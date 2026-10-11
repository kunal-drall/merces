import type { PeriodState } from '@merces/domain';
import { lateAccrual, projectDeadlines, standingOf, toPid } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { ledgerClock, statusParams } from '../engine/ledger.ts';
import { reportablePeriods } from '../engine/status.ts';

/**
 * One period as the API shows it, on Stage 1's clock: the deadline instants from `projectDeadlines` (formal notice at
 * period end + 90 days of unpaused time), the standing from `standingOf` (`Deferred` while a hardship pause runs and
 * the period is unsettled) and, while the period holds the open due, the live amount due: the open due plus Stage 1's
 * lateness accrual for a regular period, the open due alone for a tail period.
 */
export function toPeriodState(x: SimSeries, periodId: string, now: number): PeriodState {
  const pid = toPid(periodId);
  const t = BigInt(now);
  const clock = ledgerClock(x);
  const params = statusParams(x);
  const d = projectDeadlines(pid, x.ledger.pauses, t, params);
  const p = x.periods.get(periodId);
  const settled = !!p?.settled;
  const l = x.ledger;
  const open = l.openDuePeriod === pid && l.openDueAmount > 0n;
  const liveAccrual = open && !p?.isTail ? lateAccrual(pid, l.openDueAmount, clock, t, params) : (p?.accrualPaid ?? 0n);
  const liveDue = open ? l.openDueAmount + (p?.isTail ? 0n : liveAccrual) : (p?.paymentDue ?? 0n);
  return {
    seriesId: x.seriesId, periodId, dueAt: Number(d.dueAt), graceEndsAt: Number(d.graceEndsAt), formalNoticeAt: Number(d.formalNoticeAt), reportAccepted: !!p?.reportAccepted, tier: p?.tier ?? null,
    paymentStable: s(p?.reportAccepted ? p.paymentStable : 0n), paymentDue: s(liveDue), accrual: s(liveAccrual), paid: s(p?.paid ?? 0n), splitReceived: s(p?.splitReceived ?? 0n), settled, standing: standingOf(pid, clock, t, params, settled),
    incomeCommitment: p?.incomeCommitment ?? null, priorIncomeCommitment: p?.priorIncomeCommitment ?? null, liquidityEvent: !!p?.liquidityEvent,
  };
}
/** Every completed quarter plus every period with a record, in order. */
export function listPeriodStates(x: SimSeries, now: number): PeriodState[] {
  const ids = new Set<string>(reportablePeriods(x, now).map((p) => p.id));
  for (const k of x.periods.keys()) ids.add(k);
  return [...ids].sort().map((id) => toPeriodState(x, id, now));
}

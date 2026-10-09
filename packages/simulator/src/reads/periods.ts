import type { PeriodState } from '@merces/domain';
import { parsePeriod, periodStanding } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { accrualNow, deadlines, reportablePeriods } from '../engine/status.ts';

export function toPeriodState(x: SimSeries, periodId: string, now: number): PeriodState {
  const period = parsePeriod(periodId);
  const d = deadlines(x, period, now);
  const p = x.periods.get(periodId);
  const settled = !!p?.settled;
  // interest keeps running until paid: show the live amount due
  const liveAccrual = p && p.reportAccepted && !settled && !p.isTail ? accrualNow(x, period, p.outstanding, now) : (p?.accrual ?? 0n);
  const liveDue = p && p.reportAccepted && !settled && !p.isTail ? p.outstanding + liveAccrual : (p?.paymentDue ?? 0n);
  const standing: PeriodState['standing'] = x.status === 'Paused' && !settled ? 'Deferred' : periodStanding(d, now, settled);
  return {
    seriesId: x.seriesId, periodId, dueAt: d.dueAt, graceEndsAt: d.graceEndsAt, formalNoticeAt: d.formalNoticeAt, reportAccepted: !!p?.reportAccepted, tier: p?.tier ?? null,
    paymentDue: s(liveDue), accrual: s(liveAccrual), paid: s(p?.paid ?? 0n), splitReceived: s(p?.splitReceived ?? 0n), settled, standing, incomeCommitment: p?.incomeCommitment ?? null, liquidityEvent: !!p?.liquidityEvent,
  };
}
/** Every completed quarter plus every period with a record, in order. */
export function listPeriodStates(x: SimSeries, now: number): PeriodState[] {
  const ids = new Set<string>(reportablePeriods(x, now).map((p) => p.id));
  for (const k of x.periods.keys()) ids.add(k);
  return [...ids].sort().map((id) => toPeriodState(x, id, now));
}

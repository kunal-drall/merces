import type { QuarterRateState, RateAccumulatorState } from '@merces/domain';
import type { SimRateAccumulator } from '../state.ts';
import { str as s } from '../engine/core.ts';
import type { quarterRate } from '../engine/fx.ts';

export function toRateAccumulator(pair: string, a: SimRateAccumulator): RateAccumulatorState {
  const last = a.days.at(-1);
  return { pair, sumWad: s(a.sumWad), count: a.count, lastDayIndex: last?.dayIndex ?? null, lastRateWad: last ? s(last.rateWad) : null };
}
export function toQuarterRate(pair: string, periodId: string, q: NonNullable<ReturnType<typeof quarterRate>>): QuarterRateState {
  return { pair, periodId, avgWad: q.avgWad === null ? null : s(q.avgWad), snapshots: q.snapshots, daysInQuarter: q.days, coverageOk: q.coverageOk, needsFallback: q.needsFallback, fallbackReason: q.reason };
}

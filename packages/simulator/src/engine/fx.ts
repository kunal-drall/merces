import { ChainError, DEFAULTS, type Command } from '@merces/domain';
import { interim, parsePeriod, utcDayIndex } from '@merces/math';
import { big, str, type EngineCore, type Emit } from './core.ts';

// ------------------------------------------------------------------ rate accumulator
export function snapshotRate(e: EngineCore, cmd: Extract<Command, { kind: 'snapshotRate' }>, now: number, emit: Emit): void {
  if (now - cmd.publishTime > DEFAULTS.maxRateAgeSeconds || cmd.publishTime > now + 60) throw new ChainError('TooLate', 'stale price update');
  const rate = big(cmd.rateWad);
  const conf = big(cmd.confWad);
  if (rate <= 0n) throw new ChainError('InvalidTerms', 'rate must be positive');
  if (conf * 100n > rate) throw new ChainError('InvalidTerms', 'confidence interval too wide (>1%)');
  let acc = e.state.rates.get(cmd.pair);
  if (!acc) {
    acc = { pair: cmd.pair, sumWad: 0n, count: 0, days: [] };
    e.state.rates.set(cmd.pair, acc);
  }
  const day = utcDayIndex(now);
  const last = acc.days[acc.days.length - 1];
  if (last && last.dayIndex >= day) throw new ChainError('Duplicate', 'one snapshot per UTC day per feed');
  acc.sumWad += rate;
  acc.count += 1;
  acc.days.push({ dayIndex: day, rateWad: rate, cumSumWad: acc.sumWad, cumCount: acc.count });
  emit('RateSnapshot', { pair: cmd.pair, rateWad: cmd.rateWad, confWad: cmd.confWad, publishTime: cmd.publishTime, dayIndex: day, sumWad: str(acc.sumWad), count: acc.count });
}
export function quarterRate(e: EngineCore, pair: string, periodId: string): { avgWad: bigint | null; snapshots: number; days: number; coverageOk: boolean; needsFallback: boolean; reason: 'coverage' | 'deviation' | null } | null {
  const acc = e.state.rates.get(pair);
  const per = parsePeriod(periodId);
  const flag = e.state.fxFallbacks.get(`${pair}|${periodId}`) ?? null;
  if (!acc) return { avgWad: null, snapshots: 0, days: per.days, coverageOk: false, needsFallback: true, reason: flag ?? 'coverage' };
  const startDay = utcDayIndex(per.start);
  const endDay = utcDayIndex(per.end);
  const before = acc.days.filter((d) => d.dayIndex < startDay).at(-1);
  const upTo = acc.days.filter((d) => d.dayIndex < endDay).at(-1);
  const sumStart = before?.cumSumWad ?? 0n;
  const countStart = before?.cumCount ?? 0;
  const sumEnd = upTo?.cumSumWad ?? 0n;
  const countEnd = upTo?.cumCount ?? 0;
  const n = countEnd - countStart;
  const cov = interim.coverageOk(n, per.days, BigInt(DEFAULTS.minCoverageBps));
  const needsFallback = !cov || flag !== null;
  return { avgWad: n > 0 ? interim.quarterAverageRate(sumEnd, sumStart, countEnd, countStart) : null, snapshots: n, days: per.days, coverageOk: cov, needsFallback, reason: flag ?? (cov ? null : 'coverage') };
}
export function flagFxFallback(e: EngineCore, cmd: Extract<Command, { kind: 'flagFxFallback' }>, now: number, emit: Emit): void {
  const per = parsePeriod(cmd.periodId);
  if (per.end > now) throw new ChainError('TooEarly', 'quarter not over');
  const key = `${cmd.pair}|${cmd.periodId}`;
  if (e.state.fxFallbacks.has(key)) throw new ChainError('Duplicate', 'already flagged');
  if (cmd.reason === 'coverage') {
    const q = quarterRate(e, cmd.pair, cmd.periodId);
    if (q && q.coverageOk) throw new ChainError('InvalidTerms', 'coverage is sufficient');
  }
  // 'deviation': the live contracts check Chainlink themselves; the simulator trusts the keeper's evidence (A-FX-2).
  e.state.fxFallbacks.set(key, cmd.reason);
  emit('FxFallbackFlagged', { pair: cmd.pair, periodId: cmd.periodId, reason: cmd.reason });
}

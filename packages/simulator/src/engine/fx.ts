import { ChainError, DEFAULTS, type Command } from '@merces/domain';
import { DEFAULT_PARAMETERS, U64_MAX, newFxPairState, validatePythPrice, snapshot, quarterAverage, normalizePythPrice, invertRate, fxPairId, pidAt, tradingDaysInPeriod, toPid, fromPid, parsePeriod, utcDayIndex } from '@merces/math';
import { fail, guardStage1 } from './errors.ts';
import { big, str, type EngineCore, type Emit } from './core.ts';

// ------------------------------------------------------------------ rate accumulator
export function snapshotRate(e: EngineCore, cmd: Extract<Command, { kind: 'snapshotRate' }>, now: number, emit: Emit): void {
  if (now - cmd.publishTime > DEFAULTS.maxRateAgeSeconds || cmd.publishTime > now + 60) throw new ChainError('TooLate', 'stale price update');
  const rate = big(cmd.rateWad);
  const conf = big(cmd.confWad);
  if (rate <= 0n) throw new ChainError('InvalidTerms', 'rate must be positive');
  if (conf * 100n > rate) throw new ChainError('InvalidTerms', 'confidence interval too wide (>1%)');
  if (cmd.pair.startsWith('0x')) throw new ChainError('InvalidTerms', 'registered pairs require snapshotFx with raw Pyth fields');
  let acc = e.state.rates.get(cmd.pair);
  if (!acc) {
    acc = { ...newFxPairState(), pair: cmd.pair, config: null, days: [] };
    e.state.rates.set(cmd.pair, acc);
  }
  const day = utcDayIndex(now);
  const last = acc.days[acc.days.length - 1];
  if (last && last.dayIndex >= day) throw new ChainError('Duplicate', 'one snapshot per UTC day per feed');
  Object.assign(acc, snapshot(acc, BigInt(now), rate, null, DEFAULT_PARAMETERS).state);
  acc.days.push({ dayIndex: day, rateWad: rate, cumSumWad: acc.sumWad, cumCount: acc.count });
  emit('RateSnapshot', { pair: cmd.pair, rateWad: cmd.rateWad, confWad: cmd.confWad, publishTime: cmd.publishTime, dayIndex: day, sumWad: str(acc.sumWad), count: acc.count });
}
export function quarterRate(e: EngineCore, pair: string, periodId: string): { avgWad: bigint | null; snapshots: number; days: number; coverageOk: boolean; needsFallback: boolean; reason: 'coverage' | 'deviation' | null } | null {
  const acc = e.state.rates.get(pair);
  const per = parsePeriod(periodId);
  const flag = e.state.fxFallbacks.get(`${pair}|${periodId}`) ?? null;
  if (!acc) return { avgWad: null, snapshots: 0, days: per.days, coverageOk: false, needsFallback: true, reason: flag ?? 'coverage' };
  const q = quarterAverage(acc, toPid(periodId), DEFAULT_PARAMETERS, BigInt(e.clock.now()));
  const needsFallback = !q.ok || flag !== null;
  return { avgWad: q.avgWad, snapshots: q.n, days: per.days, coverageOk: q.avgWad !== null && BigInt(q.n) * 10000n >= tradingDaysInPeriod(toPid(periodId)) * BigInt(DEFAULT_PARAMETERS.fxMinCoverageBps), needsFallback, reason: flag ?? (q.flagged ? 'deviation' : q.ok ? null : 'coverage') };
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


/** Write-once pair identity, Stage 1 registry set_fx_pair. */
export function setFxPair(e: EngineCore, cmd: Extract<Command, { kind: 'setFxPair' }>, now: number, emit: Emit): void {
  const pairId = '0x' + Buffer.from(fxPairId(cmd.feedId, cmd.inverted)).toString('hex');
  if (e.state.rates.has(pairId)) fail('FxPairExists');
  const effectivePeriod = pidAt(BigInt(now));
  e.state.rates.set(pairId, { ...newFxPairState(), pair: pairId, config: { feedId: cmd.feedId, inverted: cmd.inverted, crosscheck: cmd.crosscheck, effectivePeriod }, days: [] });
  emit('FxPairSet', { pairId, feedId: cmd.feedId, inverted: cmd.inverted, crosscheck: cmd.crosscheck, effectivePeriod: fromPid(effectivePeriod) });
}

/** Stage 1 raw-price snapshot, with wide normalization before optional inversion. */
export function snapshotFx(e: EngineCore, cmd: Extract<Command, { kind: 'snapshotFx' }>, now: number, emit: Emit): void {
  const acc = e.state.rates.get(cmd.pairId);
  if (!acc?.config) fail('UnknownFxPair');
  if (BigInt(utcDayIndex(now)) <= acc.lastDay) fail('SnapshotAlreadyTaken');
  const p = { price: BigInt(cmd.price), conf: BigInt(cmd.conf), expo: cmd.expo, publishTime: BigInt(cmd.publishTime) };
  const bad = validatePythPrice(p, BigInt(now), DEFAULT_PARAMETERS);
  if (bad === 'ConfidenceTooWide') fail('ConfidenceTooWide');
  if (bad) fail('StalePrice');
  const normal = guardStage1(() => normalizePythPrice(p.price, p.expo), 'AmountOutOfRange');
  const rate = acc.config.inverted ? invertRate(normal) : normal;
  const solana = e.state.config.family === 'solana';
  if (solana && (normal >= 1n << 128n || rate > U64_MAX)) fail('AmountOutOfRange');
  let cross: bigint | null = null;
  if (acc.config.crosscheck && pidAt(BigInt(now)) >= acc.config.effectivePeriod) {
    if (solana && cmd.crosscheckPrice === undefined) fail('CrosscheckRequired');
    const cp = BigInt(cmd.crosscheckPrice ?? '0');
    const fresh = BigInt(cmd.crosscheckPublishTime ?? cmd.publishTime) + DEFAULT_PARAMETERS.fxMaxStalenessSeconds >= BigInt(now);
    if (solana && !fresh) fail('StalePrice');
    if (solana && cp <= 0n) fail('StalePrice');
    // EVM MercesFxAccumulator._chainlink: unavailable/stale/nonpositive answers flag nothing.
    if (cp > 0n && fresh) {
      const expo = cmd.crosscheckExpo ?? cmd.expo;
      if (solana) {
        cross = guardStage1(() => normalizePythPrice(cp, expo), 'AmountOutOfRange');
        if (cross >= 1n << 128n) fail('AmountOutOfRange');
      } else cross = expo >= -18 ? cp * 10n ** BigInt(18 + expo) : cp / 10n ** BigInt(-18 - expo);
      if (cross > 0n) {
        if (acc.config.inverted) cross = invertRate(cross);
        if (solana && cross > U64_MAX) fail('AmountOutOfRange');
      } else cross = null;
    }
  }
  const r = snapshot(acc, BigInt(now), rate, cross, DEFAULT_PARAMETERS);
  Object.assign(acc, r.state);
  acc.days.push({ dayIndex: Number(r.day), rateWad: rate, cumSumWad: acc.sumWad, cumCount: acc.count });
  emit('RateSnapshot', { pair: cmd.pairId, rateWad: rate.toString(), confWad: ((p.conf * rate) / p.price).toString(), publishTime: Number(p.publishTime), dayIndex: Number(r.day), sumWad: acc.sumWad.toString(), count: acc.count });
  if (r.flagged) emit('FxFallbackFlagged', { pair: cmd.pairId, periodId: fromPid(r.period), reason: 'deviation' });
}

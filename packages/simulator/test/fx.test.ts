import { describe, expect, it } from 'vitest';
import { fxPairId, WAD, parsePeriod, ratePerUnit, wadFromDecimal } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, expectChainError, types } from './helpers.ts';

/*
 * S4 cause codes:
 *  - S4-FX: the FX fallback is an attestor key's Stage 1 `MERCES_FX_V1` signature per series (S4 WP9, D14), carried in
 *    `submitReport.fxFallback` (was the attestor rate, co-signed by the attestor).
 */

describe('rate accumulator and FX fallback', () => {
  it('snapshots once per day, averages the quarter, flags low coverage and requires an attestor rate', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'EUR', indexingRule: 'cpi-annual', termsSalt: BigInt('0x' + '33'.repeat(31)) }, terms: { reportingCurrency: 'EUR' } });
    const q1 = parsePeriod('2026Q1');
    // snapshot every day of Q1 at 1.08 then 1.10 (sim time is already past the auction; go to Q1 start)
    let t = Math.max(await h.sim.now(), q1.start);
    let n = 0;
    while (t < q1.end) {
      const rate = n % 2 === 0 ? wadFromDecimal('1.08') : wadFromDecimal('1.10');
      await h.sim.submit({ kind: 'snapshotRate', pair: 'EUR/USD', rateWad: rate.toString(), confWad: wadFromDecimal('0.0005').toString(), publishTime: t, update: null }, 'keeper');
      await expectChainError(h.sim.submit({ kind: 'snapshotRate', pair: 'EUR/USD', rateWad: rate.toString(), confWad: '0', publishTime: t, update: null }, 'keeper'), 'Duplicate');
      t += 86_400;
      n++;
      await h.sim.setTime(t);
    }
    const q = (await h.sim.getQuarterRate('EUR/USD', '2026Q1'))!;
    expect(q.coverageOk).toBe(true);
    expect(q.needsFallback).toBe(false);
    expect(BigInt(q.avgWad!)).toBeGreaterThan(wadFromDecimal('1.08'));
    await expectChainError(h.sim.submit({ kind: 'flagFxFallback', pair: 'EUR/USD', periodId: '2026Q1', reason: 'coverage' }, 'keeper'), 'InvalidTerms');
    // EUR report must use the accumulator rate
    await h.sim.setTime(q1.end + 86_400);
    const fx = BigInt(q.avgWad!);
    await expect(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 70_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx + 1n })).rejects.toThrow(/accumulator/);
    const ok = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 70_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx });
    expect(ok.paymentStable).toBe((2_000_000_000n * fx) / WAD);
    // Q2 has no snapshots → fallback flagged, attestor rate required
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const flag = await h.sim.submit({ kind: 'flagFxFallback', pair: 'EUR/USD', periodId: '2026Q2', reason: 'coverage' }, 'keeper');
    expect(types(flag.events)).toEqual(['FxFallbackFlagged']);
    await expect(h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 70_000_000_000n, 90_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx })).rejects.toThrow();
    // cause S4-FX: the attestor key's FX signature for this series over the report's own rate (was the co-signed attestor rate)
    const att = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 70_000_000_000n, 90_000_000_000n, { fxBasis: 'attestor', pair: 'EUR/USD', fxAvgWad: wadFromDecimal('1.09'), fxFallback: h.attestors[1]! });
    expect(att.paymentStable).toBe(2_180_000_000n);
  });
});

// Stage 1 Solana fx.rs requires the configured second feed; EVM ignores an unavailable/stale answer.
describe.each(['solana', 'monad'] as const)('registered raw FX snapshots (%s)', (personality) => {
  it('enforces write-once identity, raw snapshots and the chain-specific cross-check rules', async () => {
    const h = await SimHarness.create(personality, { genesis: GENESIS });
    const feedId = '0x' + '51'.repeat(32);
    const pairId = '0x' + Buffer.from(fxPairId(feedId, false)).toString('hex');
    const register = { kind: 'setFxPair' as const, feedId, inverted: false, crosscheck: h.admin.address };
    await h.exec(h.admin, register);
    await expectChainError(h.exec(h.admin, register), 'Duplicate');
    const cmd = { kind: 'snapshotFx' as const, pairId, price: '108000000', conf: '1000', expo: -8, publishTime: String(await h.sim.now()) };
    await expectChainError(h.sim.submit({ kind: 'snapshotRate', pair: pairId, rateWad: '1', confWad: '0', publishTime: await h.sim.now(), update: null }, 'keeper'), 'InvalidTerms');
    if (personality === 'solana') {
      await expect(h.sim.submit(cmd, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'CrosscheckRequired' } });
      expect((await h.sim.getRateAccumulator(pairId))!.count).toBe(0);
    } else {
      await h.exec(h.backers[0]!, cmd);
      await h.sim.advanceTime(86400);
    }
    await h.sim.submit({ ...cmd, publishTime: String(await h.sim.now()), crosscheckPrice: '120000000', crosscheckExpo: -8 }, 'keeper');
    const q = h.sim.state.rates.get(pairId)!;
    expect([...q.checkpoints.values()][0]!.flagged).toBe(true);
    expect(q.days.at(-1)!.rateWad).toBe(wadFromDecimal('1.08'));
    await expectChainError(h.sim.submit(cmd, 'keeper'), 'Duplicate');
    await h.sim.advanceTime(86400);
    const stale = { ...cmd, publishTime: String(await h.sim.now()), crosscheckPrice: '120000000', crosscheckPublishTime: String(GENESIS - 86400) };
    if (personality === 'solana') await expectChainError(h.sim.submit(stale, 'keeper'), 'TooLate');
    else await h.sim.submit(stale, 'keeper');
  });
});

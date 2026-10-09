import { describe, expect, it } from 'vitest';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

describe('lateness, accrual and release pause', () => {
  it('sets InGrace then Late, pauses releases, accrues interest, resumes when paid, emits FormalNoticeDue', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 31 * 86_400);
    let r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('InGrace');
    await h.sim.setTime(q1.end + 46 * 86_400);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged', 'ReleasesPaused']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Late');
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'Paused');
    await h.sim.setTime(q1.end + 121 * 86_400);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['FormalNoticeDue']);
    // pay 76 days after grace end: income 100k → 4,000 gross. The report opens the due without accrual (Stage 1
    // `Report.due`); accrual = 4000 × 8% × 76/365 runs until the payment lands and is charged then.
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), termsCommitment: terms.termsCommitment });
    const acc = await h.exec(h.issuer, command);
    const p = acc.events[0]!.payload as { paymentDue: string; accrual: string };
    const accrual = (USDC(4000) * wadFromDecimal('0.08') * 76n) / (WAD * 365n);
    expect(p.accrual).toBe('0');
    expect(BigInt(p.paymentDue)).toBe(USDC(4000));
    const live = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    expect(BigInt(live.accrual)).toBe(accrual);
    expect(BigInt(live.paymentDue)).toBe(USDC(4000) + accrual);
    // Q2 also complete and unpaid now (we are 121 days after Q1 end, ~30 days after Q2 end): still in grace for Q2
    const pay = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: live.paymentDue });
    expect(types(pay.events)).toEqual(['FeeTaken', 'PaymentReceived', 'StatusChanged', 'ReleasesResumed']);
    expect((pay.events[1]!.payload as { accrual?: string }).accrual).toBe(accrual.toString());
    expect((await h.sim.getSeries(seriesId))!.status).toBe('InGrace');
    const periods = await h.sim.listPeriods(seriesId);
    expect(periods.map((x) => [x.periodId, x.standing])).toEqual([['2026Q1', 'OnTime'], ['2026Q2', 'InGrace']]);
    // nothing is slashed: treasury intact
    expect((await h.sim.getTreasury(seriesId))!.balance).toBe(USDC(4500).toString());
  });
});

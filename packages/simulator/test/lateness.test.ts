import { describe, expect, it } from 'vitest';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { seriesOf } from './kit.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';

const DAY = 86_400;

describe('status, formal notice and lateness accrual (Stage 1 clock)', () => {
  it('derives OnTime, InGrace and Late with inclusive 30- and 45-day bounds, without a crank', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const end = parsePeriod('2026Q1').end;
    const status = async (): Promise<string> => (await h.sim.getSeries(seriesId))!.status;
    // Stage 1 deriveStatus: countdown ≤ 30 days OnTime, ≤ 45 days InGrace, then Late (cause G2: both bounds inclusive)
    const marks: [number, string][] = [[end, 'OnTime'], [end + 30 * DAY, 'OnTime'], [end + 30 * DAY + 1, 'InGrace'], [end + 45 * DAY, 'InGrace'], [end + 45 * DAY + 1, 'Late']];
    for (const [t, expected] of marks) {
      await h.sim.setTime(t);
      expect(await status()).toBe(expected);
    }
    // the stored status only moves at a sync point
    expect(seriesOf(h.sim, seriesId).status).toBe('OnTime');
    const r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged', 'ReleasesPaused']);
    expect(seriesOf(h.sim, seriesId).status).toBe('Late');
  });

  it('crankStatus is a successful no-op before settlement (Stage 1 crank_status)', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const seriesId = (created.events.find((e) => e.type === 'SeriesCreated')!.payload as { seriesId: string }).seriesId;
    await h.sim.setTime(parsePeriod('2026Q1').end + 100 * DAY);
    const r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toEqual([]);
    expect(seriesOf(h.sim, seriesId).ledger.formalNoticeEmittedFor).toBeNull();
  });

  it('InGrace then Late blocks releases, formal notice at period end + 90 days, accrual runs until paid', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 31 * DAY);
    let r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('InGrace');
    await h.sim.setTime(q1.end + 46 * DAY);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged', 'ReleasesPaused']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Late');
    expect((await h.sim.getTreasury(seriesId))!.paused).toBe(true);
    await expectStage1Error(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'SeriesLate');
    // deadlines from Stage 1's countdown: due at end + 30 days, grace to end + 45 days, notice at end + 90 days
    // (cause N: the notice was due date + 90 = end + 120 days)
    let per = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    expect([per.dueAt, per.graceEndsAt, per.formalNoticeAt]).toEqual([q1.end + 30 * DAY, q1.end + 45 * DAY, q1.end + 90 * DAY]);
    expect(per.standing).toBe('Late');
    await h.sim.setTime(q1.end + 90 * DAY - 1);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toEqual([]);
    await h.sim.setTime(q1.end + 90 * DAY);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['FormalNoticeDue']);
    expect(r.events[0]!.payload).toMatchObject({ periodId: '2026Q1' });
    expect((await h.sim.getSeries(seriesId))!.formalNoticeEmittedFor).toBe('2026Q1');
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.standing).toBe('FormalNoticeDue');
    // once per period
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toEqual([]);
    // pay 76 days after grace end: income 100k → 4,000 gross. The report opens the due without accrual (Stage 1
    // `Report.due`); accrual = 4000 × 8% × 76/365 runs until the payment lands and is charged then.
    await h.sim.setTime(q1.end + 121 * DAY);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), termsCommitment: terms.termsCommitment });
    const acc = await h.exec(h.issuer, command);
    const p = acc.events[0]!.payload as { paymentDue: string; accrual: string };
    const accrual = (USDC(4000) * wadFromDecimal('0.08') * 76n) / (WAD * 365n);
    expect(accrual).toBe(66_630_136n);
    expect(p.accrual).toBe('0');
    expect(BigInt(p.paymentDue)).toBe(USDC(4000));
    const live = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    expect(BigInt(live.accrual)).toBe(accrual);
    expect(BigInt(live.paymentDue)).toBe(USDC(4000) + accrual);
    const pay = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: live.paymentDue });
    expect(types(pay.events)).toEqual(['FeeTaken', 'PaymentReceived', 'StatusChanged', 'ReleasesResumed']);
    expect((pay.events[1]!.payload as { accrual?: string }).accrual).toBe(accrual.toString());
    // Q2 also ended, unreported, exactly 30 days ago: OnTime under Stage 1's inclusive bound (cause G2: was InGrace)
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    const periods = await h.sim.listPeriods(seriesId);
    expect(periods.map((x) => [x.periodId, x.standing])).toEqual([['2026Q1', 'OnTime'], ['2026Q2', 'OnTime']]);
    per = periods[1]!;
    expect(per.formalNoticeAt).toBe(parsePeriod('2026Q2').end + 90 * DAY);
    // the notice stays recorded for the period it was due for
    expect((await h.sim.getSeries(seriesId))!.formalNoticeEmittedFor).toBe('2026Q1');
    // nothing is slashed: treasury intact
    const tr = (await h.sim.getTreasury(seriesId))!;
    expect(tr.balance).toBe(USDC(4500).toString());
    expect(tr.paused).toBe(false);
  });
});

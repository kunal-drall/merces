import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

describe('hardship pause', () => {
  it('needs an attestor, defers deadlines without accrual, and ends by crank', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 10 * 86_400);
    const until = q1.end + 100 * 86_400;
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until });
    await expectChainError(h.exec(h.backers[0]!, { kind: 'approvePause', seriesId, until }), 'Unauthorized');
    const ap = await h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until });
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    // 60 days later: without the pause we'd be Late; paused instead and deadlines deferred
    await h.sim.setTime(q1.end + 70 * 86_400);
    const r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toHaveLength(0);
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.standing).toBe('Deferred');
    await expectChainError(h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper'), 'TooEarly');
    await h.sim.setTime(until);
    const ended = await h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper');
    expect(types(ended.events)[0]).toBe('PauseEnded');
    const per = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    // due shifted by the 90 paused days: original due = end+30d → end+120d
    expect(per.dueAt).toBe(q1.end + 120 * 86_400);
    expect(per.standing).toBe('NotDue');
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    // paying now carries no accrual
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    expect(res.due).toBe(USDC(4000));
  });
});

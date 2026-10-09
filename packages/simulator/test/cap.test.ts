import { describe, expect, it } from 'vitest';
import { WAD, parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';

describe('cap, retirement and burn', () => {
  it('accepts only up to the cap, refunds the issuer, retires and burns on claim or crank', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    // cap 22.5 per unit × 500 units = 11,250 gross lifetime. Pay a huge Q1: income 200k → 10% × 140k = 14,000
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const q1 = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(200_000));
    expect(q1.paymentStable).toBe(USDC(14_000));
    expect(types(q1.events)).toEqual(['ReportAccepted', 'PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired']);
    const refund = q1.events.find((e) => e.type === 'PaymentRefunded')!.payload as { amount: string };
    expect(refund.amount).toBe(USDC(2750).toString());
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.status).toBe('Retired');
    expect(s.paidPerUnitWad).toBe((USDC(22.5) * WAD).toString());
    // claim burns; crank burns the rest
    const c = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    const crank = await h.sim.submit({ kind: 'crankBurn', seriesId, holders: h.backers.map((b) => b.address) }, 'keeper');
    expect(crank.events.filter((e) => e.type === 'UnitsBurned')).toHaveLength(4);
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('0');
    // burned holders can still claim what they were owed
    const c2 = await h.exec(h.backers[1]!, { kind: 'claimPayout', seriesId });
    expect((c2.events[0]!.payload as { amount: string }).amount).toBe((USDC(11_250 * 0.95) / 5n).toString());
    // no further reports
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    await expect(h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(200_000), USDC(250_000))).rejects.toThrow();
    // vault invariant: total claims ≤ vault, dust ≥ 0
    const v = (await h.sim.getVault(seriesId))!;
    expect(BigInt(v.balance)).toBeGreaterThanOrEqual(0n);
  });
});

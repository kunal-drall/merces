import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';

describe('tier 1 split receipts and multi-series issuers', () => {
  it('reconciles router receipts against the quarterly report', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    await h.sim.setTime(parsePeriod('2026Q1').start + 40 * 86_400);
    const r = await h.sim.postSplitReceipt(h.router, seriesId, USDC(1000));
    expect(types(r.events)).toEqual(['FeeTaken', 'PaymentReceived', 'SplitReceipt']);
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    // report says 10% × (100k − 60k) = 4,000; 1,000 already arrived via the split → 3,000 due
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000), { tier: 1, source: 'split' });
    expect(res.due).toBe(USDC(3000));
    // second series for the same issuer
    const second = await h.runRaise({ terms: { unitsOffered: '500' } });
    expect(second.seriesId).not.toBe(seriesId);
    expect((await h.sim.getIssuer(h.issuer.address))!.seriesIds).toHaveLength(2);
  });
});

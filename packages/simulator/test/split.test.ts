import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';

/*
 * Cause code:
 *  - S4-TU: `PeriodState.paymentStable` is the accepted report's payment figure (Stage 1's `Report.payment_usd`), which
 *    bounds a negative true-up (S4 WP13); '0' until reported.
 */
describe('tier 1 split receipts and multi-series issuers', () => {
  it('reconciles router receipts against the quarterly report', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    // tier 1 is a report tier only on a pure tier-1 series (Stage 1)
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: false, tier3: false, tier4: false } } });
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    await h.sim.setTime(parsePeriod('2026Q1').start + 40 * 86_400);
    const r = await h.sim.postSplitReceipt(h.router, seriesId, USDC(1000));
    expect(types(r.events)).toEqual(['FeeTaken', 'PaymentReceived', 'SplitReceipt']);
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.paymentStable).toBe('0'); // cause S4-TU: '0' until reported
    // report says 10% × (100k − 60k) = 4,000; 1,000 already arrived via the split → 3,000 due
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000), { tier: 1, source: 'split' });
    expect(res.due).toBe(USDC(3000));
    // cause S4-TU: the period read carries the report's own payment figure (Stage 1's payment_usd, before the router's
    // credit): what bounds a negative true-up, not the due
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!).toMatchObject({ paymentStable: USDC(4000).toString(), splitReceived: USDC(1000).toString() });
    // a tier-1 report on a series that also enables tier 2 is refused (Stage 1 TierNotEnabled)
    const mixed = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: true, tier3: false, tier4: false } } });
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400); // its first period is the settlement quarter, 2026Q2
    await expectStage1Error(h.reportAndPay(mixed.seriesId, '2026Q2', mixed.privateTerms, mixed.terms.termsCommitment, 0n, USDC(100_000), { tier: 1, source: 'split' }), 'TierNotEnabled');
    // second series for the same issuer
    const second = await h.runRaise({ terms: { unitsOffered: '500' } });
    expect(second.seriesId).not.toBe(seriesId);
    expect((await h.sim.getIssuer(h.issuer.address))!.seriesIds).toHaveLength(3);
  });

  it('a split receipt above the cap refunds the issuer, not the router, and retires the series', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: false, tier3: false, tier4: false } } });
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    await h.sim.setTime(parsePeriod('2026Q1').start + 40 * 86_400);
    const [routerBefore, issuerBefore] = [BigInt(await h.sim.getBalance(h.router, 'USDC')), BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))];
    // cap 22.5 × 500 = 11,250: of 12,000 routed, 750 goes back to the issuer (Stage 1 routes the refund to the issuer)
    const r = await h.sim.postSplitReceipt(h.router, seriesId, USDC(12_000));
    expect(types(r.events)).toEqual(['PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired', 'SplitReceipt']);
    expect(r.events.find((e) => e.type === 'SplitReceipt')!.payload).toMatchObject({ periodId: '2026Q1', amount: USDC(11_250).toString() });
    expect(r.events.find((e) => e.type === 'FeeTaken')!.payload).toMatchObject({ payer: h.router });
    expect(BigInt(await h.sim.getBalance(h.router, 'USDC'))).toBe(routerBefore - USDC(12_000));
    expect(BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))).toBe(issuerBefore + USDC(750));
    const s = (await h.sim.getSeries(seriesId))!;
    expect([s.status, s.refundedToIssuer]).toEqual(['Retired', USDC(750).toString()]);
    expect(h.sim.stage1View(seriesId).ledger.grossReceived).toBe(USDC(11_250).toString());
    // a Retired series takes no more split income
    await expect(h.sim.postSplitReceipt(h.router, seriesId, USDC(1))).rejects.toThrow();
  });
});

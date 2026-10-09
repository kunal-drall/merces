import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

describe('redemption and tail', () => {
  it('quotes the formula price, blocks before lockup, pays holders and burns, then honours the tail', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 365 * 86_400 } });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    // report all 2026 quarters at modest income (80k/yr → 2,000 gross/yr = 4 per unit)
    const ytd = [20_000, 40_000, 60_000, 80_000].map(USDC);
    let prev = 0n;
    for (const [i, q] of ['2026Q1', '2026Q2', '2026Q3', '2026Q4'].entries()) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      await h.reportAndPay(seriesId, q, privateTerms, terms.termsCommitment, prev, ytd[i]!);
      prev = ytd[i]!;
    }
    await expectChainError(h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() }), 'TooEarly');
    await h.sim.setTime(settledAt + 365 * 86_400 + 10);
    // 2027Q1 not yet complete, so no unpaid periods block the redemption (A-RED-1)
    const quote = h.sim.engine.quote(h.sim.state.series.get(seriesId)!, await h.sim.now());
    // hurdle: 9 × 1.08 = 9.72; D_avg over 1 full year = 2000/500 = 4 → k×D = 20; C_remaining = 22.5 − 4 = 18.5 → bound by cap
    expect(quote.hurdlePrice).toBe(USDC(9.72));
    expect(quote.payoutTerm).toBe(USDC(20));
    expect(quote.pricePerUnit).toBe(USDC(18.5));
    expect(quote.boundBy).toBe('cap');
    await expectChainError(h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(18).toString() }), 'InvalidTerms');
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(18.5).toString() });
    expect(types(r.events)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const red = (await h.sim.getRedemption(seriesId))!;
    expect(red.deposit).toBe(USDC(18.5 * 500).toString());
    expect(red.tailCapPerUnit).toBe('0');
    const before = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
    const c = await h.exec(h.backers[0]!, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    const after = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
    expect(after - before).toBe(USDC(1850) + (USDC(2000 * 0.95) / 5n));
    // tail: price equalled C_remaining → no tail is owed: a liquidity-event report is refused (Stage 1 NoTailDue), and an
    // ordinary report is accepted with nothing due, only advancing the commitment chain
    await h.sim.setTime(parsePeriod('2027Q1').end + 86_400);
    await expectStage1Error(h.reportAndPay(seriesId, '2027Q1', privateTerms, terms.termsCommitment, 0n, USDC(1_000_000), { liquidityEvent: true }), 'NoTailDue');
    const tail = await h.reportAndPay(seriesId, '2027Q1', privateTerms, terms.termsCommitment, 0n, USDC(1_000_000));
    expect(tail.due).toBe(0n);
    expect(tail.paid).toBe(0n);
  });
  it('pays a capped tail when redemption was bound by the hurdle', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 30 * 86_400 } });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000));
    await h.sim.setTime(Math.max(settledAt + 31 * 86_400, parsePeriod('2026Q1').end + 2 * 86_400));
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(10).toString() });
    const opened = r.events[0]!.payload as { pricePerUnit: string; tailCapPerUnit: string };
    expect(BigInt(opened.pricePerUnit)).toBeGreaterThan(USDC(9)); // hurdle-bound, < 1 year → linear accrual
    const tailCap = BigInt(opened.tailCapPerUnit);
    expect(tailCap).toBe(USDC(22.5) - BigInt(opened.pricePerUnit));
    // Q2 liquidity event: 10% × (2M − 60k) ≈ 194,000 → 388/unit, capped at tailCap per unit
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    // the report opens the full payment as due (Stage 1 `Report.due`); the cap applies when it is paid, and the excess
    // goes back to the issuer
    const tail = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(2_000_000), { liquidityEvent: true });
    expect(tail.due).toBe(tail.paymentStable);
    expect(tail.due).toBeGreaterThan(tailCap * 500n);
    const payout = tail.events.find((e) => e.type === 'TailPayout')!.payload as { total: string };
    expect(BigInt(payout.total)).toBe(tailCap * 500n);
    const refund = tail.events.find((e) => e.type === 'PaymentRefunded')!.payload as { amount: string; reason: string };
    expect([BigInt(refund.amount), refund.reason]).toEqual([tail.due - tailCap * 500n, 'cap']);
    const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
    expect(BigInt(pos.tailClaimable)).toBe((tailCap * 500n * 95n / 100n) / 5n);
    await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    // the cap is used up: a second liquidity-event report is refused (Stage 1 NoTailDue)
    await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(2_000_000), USDC(3_000_000), { liquidityEvent: true }), 'NoTailDue');
  });
});

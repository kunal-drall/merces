import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@merces/domain';
import { WAD, parsePeriod, redemptionQuote, toPid } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';
import { seedLedger, seriesOf } from './kit.ts';

/**
 * The money paths take the series' unit scale (S3 WP6, cause S3-V4): the vault receipt (`vaultReceiveGrossScaled`), the
 * redemption quote and deposit (`redemptionQuoteScaled`), the redemption principal (`scaledAmount`), the tail
 * (`tailReceiveScaled`, `TailPayout.perUnit`) and the tail read (`tailPaidPerUnit`). Every series has scale 1 until curve
 * mode keeps base lamports (WP8), and at scale 1 these are Stage 1's own functions: the unchanged suite, the vectors and
 * the lockstep are the identity proof.
 *
 * This test proves the wiring: the same sealed-bid series is run twice, once as it is and once rescaled white-box right
 * after delivery to 10^6 accounting units per whole unit (every unit count × 10^6, prices per whole unit unchanged), as
 * a curve series counts base lamports. Every amount of stablecoin must come out the same, as merces-common's scale
 * invariance says (`properties.rs:165-205`), and every unit count 10^6 times larger. A money path that ignored the scale
 * would read the cap per accounting unit 10^6 times too high and the deposit 10^6 times too large.
 */

const SCALE = 1_000_000n;
const DAY = 86_400;

type Payload = Record<string, string>;
const payload = (events: DomainEvent[], type: string): Payload => events.find((e) => e.type === type)!.payload as Payload;
const without = (p: Payload, ...keys: string[]): Payload => Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)));

async function run(scale: bigint) {
  const h = await SimHarness.create('monad', { genesis: GENESIS });
  // 500 units at 9 USDC, cap 22.5 per unit, five holders of 100 units
  const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
  const s = seriesOf(h.sim, seriesId);
  if (scale !== 1n) {
    s.unitScale = scale;
    s.unitsOutstanding *= scale;
    s.unitsSold *= scale;
    for (const p of s.positions.values()) p.units *= scale;
  }
  const [b0, b1, b2] = h.backers as [typeof h.backers[0], typeof h.backers[0], typeof h.backers[0]];
  const bal = async (w: string) => BigInt(await h.sim.getBalance(w, 'USDC'));

  // a regular payment of 2,000 for 2026Q1: 4 per whole unit, 1,900 net after the 5% fee
  await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
  seedLedger(h.sim, seriesId, { lastAcceptedPeriod: toPid('2026Q1'), openDuePeriod: toPid('2026Q1'), openDueAmount: USDC(2_000) });
  const pay = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: USDC(2_000).toString() });
  const received = payload(pay.events, 'PaymentReceived');
  const claimable0 = (await h.sim.getPosition(seriesId, b0.address))!.claimable;
  const before0 = await bal(b0.address);
  await h.exec(b0, { kind: 'claimPayout', seriesId });
  const claimed0 = (await bal(b0.address)) - before0;

  // the redemption quote and the deposit
  await h.sim.setTime(parsePeriod('2026Q1').end + 2 * DAY);
  const quote = h.sim.engine.quote(s, await h.sim.now());
  const redeem = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
  const opened = payload(redeem.events, 'RedemptionOpened');

  // a holder's redemption: its pending payout and the principal P × its units
  const redemptionClaimable1 = (await h.sim.getPosition(seriesId, b1.address))!.redemptionClaimable;
  const before1 = await bal(b1.address);
  const claim = await h.exec(b1, { kind: 'claimRedemption', seriesId });
  const redeemed1 = (await bal(b1.address)) - before1;

  // a tail payment of 10,000 for 2026Q2: the tail cap (C_rem − P_redeem per whole unit) takes its share, the rest goes back
  seedLedger(h.sim, seriesId, { lastAcceptedPeriod: toPid('2026Q2'), openDuePeriod: toPid('2026Q2'), openDueAmount: USDC(10_000) });
  const tail = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q2', amount: USDC(10_000).toString() });
  const redemption = (await h.sim.getRedemption(seriesId))!;
  const tailClaimable2 = (await h.sim.getPosition(seriesId, b2.address))!.tailClaimable;
  const before2 = await bal(b2.address);
  await h.exec(b2, { kind: 'claimTail', seriesId });
  const tailClaimed2 = (await bal(b2.address)) - before2;

  return {
    h, seriesId, s,
    money: {
      received: without(received, 'seriesId', 'paidPerUnitWad'), claimable0, claimed0,
      quote, opened: without(opened, 'seriesId', 'unitsOutstanding', 'tailEndsAt'),
      redemptionClaimable1, redeemed1, redemptionClaimed: without(payload(claim.events, 'RedemptionClaimed'), 'seriesId', 'units'),
      tailTypes: types(tail.events), tailRefund: without(payload(tail.events, 'PaymentRefunded'), 'seriesId'), tailReceived: without(payload(tail.events, 'PaymentReceived'), 'seriesId', 'paidPerUnitWad'), tailPayout: without(payload(tail.events, 'TailPayout'), 'seriesId'),
      tailCapPerUnit: redemption.tailCapPerUnit, tailPaidPerUnit: redemption.tailPaidPerUnit, tailExhausted: redemption.tailExhausted, tailRefunded: redemption.tailRefunded, tailClaimable2, tailClaimed2,
      vault: (await h.sim.getVault(seriesId))!.balance,
    },
    units: {
      paidPerUnitWad: BigInt(received.paidPerUnitWad!), unitsAtRedemption: BigInt(opened.unitsOutstanding!), redeemedUnits: BigInt(payload(claim.events, 'RedemptionClaimed').units!),
      tailPaidPerUnitWad: BigInt(redemption.tailPaidPerUnitWad),
    },
  };
}

describe('the money paths take the unit scale (S3-V4)', () => {
  it('a series rescaled to 10^6 accounting units per whole unit pays exactly what it pays at scale 1', async () => {
    const one = await run(1n);
    const scaled = await run(SCALE);
    expect((await one.h.sim.getSeries(one.seriesId))!.unitScale).toBe('1');
    expect((await scaled.h.sim.getSeries(scaled.seriesId))!.unitScale).toBe('1000000');

    // the scale-1 figures (the harness's 500 units at 9 USDC, cap 22.5, fee 5%)
    expect(one.money.received).toMatchObject({ gross: USDC(2_000).toString(), fee: USDC(100).toString(), net: USDC(1_900).toString() });
    expect([one.money.claimable0, one.money.claimed0]).toEqual([USDC(380).toString(), USDC(380)]);
    // C_rem = 22.5 − 4 = 18.5 and the hurdle decides (a quarter after settlement, no D_avg yet); the quote is Stage 1's
    // own `redemptionQuote` on the series' figures
    const q = one.money.quote;
    expect(q).toEqual(redemptionQuote({
      p0: USDC(9), hurdleRateWad: one.s.terms.hurdleWad, payoutMultipleK: Number(one.s.terms.payoutMultipleK), t: BigInt(parsePeriod('2026Q1').end + 2 * DAY - one.s.settledAt!),
      capPerUnit: USDC(22.5), paidPerUnitWad: USDC(4) * WAD, yearGross: one.s.vault.yearGross, unitsOutstanding: 500n,
    }));
    expect(q).toMatchObject({ cRemaining: USDC(18.5), paidUnits: USDC(4), decidedBy: 'hurdle', deposit: q.pRedeem * 500n, tailCapPerUnit: USDC(18.5) - q.pRedeem });
    expect(q.pRedeem > USDC(9)).toBe(true);
    expect([one.money.redemptionClaimable1, one.money.redeemed1]).toEqual([(q.pRedeem * 100n).toString(), q.pRedeem * 100n + USDC(380)]);
    // the tail cap takes its share, the rest goes back to the issuer
    const tailTotal = q.tailCapPerUnit * 500n;
    expect(one.money.tailTypes).toEqual(['PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'TailPayout']);
    expect(one.money.tailRefund).toMatchObject({ amount: (USDC(10_000) - tailTotal).toString(), reason: 'cap' });
    expect(one.money.tailPayout).toMatchObject({ perUnit: q.tailCapPerUnit.toString(), total: tailTotal.toString() });
    expect([one.money.tailPaidPerUnit, one.money.tailExhausted]).toEqual([q.tailCapPerUnit.toString(), true]);
    // b2 has not redeemed: claimTail redeems it first (380 pending and the principal), then pays its tail, 95% of the
    // tail cap on 100 units
    const tail2 = (tailTotal - tailTotal / 20n) / 5n;
    expect(one.money.tailClaimable2).toBe(tail2.toString());
    expect(one.money.tailClaimed2).toBe(USDC(380) + q.pRedeem * 100n + tail2);

    // the same money at scale 10^6
    expect(scaled.money).toEqual(one.money);
    // and the unit counts and per-accounting-unit figures 10^6 times apart
    expect(scaled.units).toEqual({
      paidPerUnitWad: one.units.paidPerUnitWad / SCALE, unitsAtRedemption: one.units.unitsAtRedemption * SCALE, redeemedUnits: one.units.redeemedUnits * SCALE,
      tailPaidPerUnitWad: one.units.tailPaidPerUnitWad / SCALE,
    });
    expect(one.units.paidPerUnitWad).toBe(USDC(4) * WAD);
  });

  it('a payment past the cap retires the series with the same refund at both scales', async () => {
    const results = [];
    for (const scale of [1n, SCALE]) {
      const h = await SimHarness.create('solana', { genesis: GENESIS });
      const { seriesId } = await h.runRaise();
      const s = seriesOf(h.sim, seriesId);
      s.unitScale = scale;
      s.unitsOutstanding *= scale;
      for (const p of s.positions.values()) p.units *= scale;
      await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
      seedLedger(h.sim, seriesId, { lastAcceptedPeriod: toPid('2026Q1'), openDuePeriod: toPid('2026Q1'), openDueAmount: USDC(20_000) });
      const r = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: USDC(20_000).toString() });
      results.push({
        types: types(r.events), refund: payload(r.events, 'PaymentRefunded').amount, gross: payload(r.events, 'PaymentReceived').gross,
        claimable: (await h.sim.getPosition(seriesId, h.backers[3]!.address))!.claimable, status: (await h.sim.getSeries(seriesId))!.status,
      });
    }
    // the cap is 22.5 × 500 = 11,250: 8,750 goes back to the issuer and the series retires
    expect(results[0]).toEqual({
      types: ['PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired'], refund: USDC(8_750).toString(), gross: USDC(11_250).toString(),
      claimable: USDC(2_137.5).toString(), status: 'Retired',
    });
    expect(results[1]).toEqual(results[0]);
  });
});

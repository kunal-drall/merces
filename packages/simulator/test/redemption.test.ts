import { describe, expect, it } from 'vitest';
import { ChainError } from '@merces/domain';
import { WAD, parsePeriod } from '@merces/math';
import { SimHarness, defaultTerms, serialiseState } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';
import { seedHolder, seedPause, seedTail, seedVault, seriesOf } from './kit.ts';

/**
 * Redemption and the tail on Stage 1 (S1 plan WP6; SIM:1158-1172, 1328-1417).
 *
 * The figures were recomputed with Stage 1 itself: Stage 1's `ScenarioBuilder` drove Stage 1's own `Simulator` through
 * the same flows, terms and dates as these tests (the harness's 500 units at 9 USDC, cap 2.5×, θ 60,000, r 10%, fee
 * 5%). Cause codes on the numbers that changed from the version-1 engine:
 *  - G6: `D_avg` reads Stage 1's year ring, where each payment is tagged with the settlement year of its report deadline
 *    (period end + 30 days), and the price is Stage 1's `redemptionQuote` (cap only on a strict `<`);
 *  - G5: the tail due is the full payment as reported; `tailReceive` caps it when it is paid and refunds the excess to
 *    the issuer; a used-up tail refuses a liquidity report (NoTailDue);
 *  - RD: Stage 1's redeem: the deposit goes into the vault, Paused is allowed, `redeemedUnits` is set when a holder
 *    claims (not at redeem), the tail runs `tailSeconds` (365 days, was 360);
 *  - TV (S1 review): the tail read is Stage 1's `claimableTail` view (MercesVault.sol:747-753): a holder that has not
 *    redeemed is shown the tail on the units its redemption would redeem, since `claim_tail` redeems them first
 *    (SIM:1403-1417); the vault dust counts it too (it showed 0 and left the tail in the dust).
 */

const DAY = 86_400;

async function settled(opts: Parameters<SimHarness['runRaise']>[0] = {}) {
  const h = await SimHarness.create('monad', { genesis: GENESIS });
  const raise = await h.runRaise(opts);
  const settledAt = (await h.sim.getSeries(raise.seriesId))!.settledAt!;
  return { h, settledAt, ...raise };
}

/** The transaction is refused with Stage 1 error `name`, and the chain's state and event log are unchanged. */
async function refused(h: SimHarness, tx: () => Promise<unknown>, name: string): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx().then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

const balance = async (h: SimHarness, wallet: string) => BigInt(await h.sim.getBalance(wallet, 'USDC'));

describe('redemption and tail', () => {
  it('quotes the price over the year ring, deposits into the vault, pays holders as they claim, then honours the capped tail', async () => {
    const { h, seriesId, terms, privateTerms, settledAt } = await settled({ terms: { lockupSeconds: 365 * DAY } });
    // report all 2026 quarters at modest income: 80k/yr against θ 60k → only 2026Q4 pays, 2,000 gross = 4 per unit
    const ytd = [20_000, 40_000, 60_000, 80_000].map(USDC);
    let prev = 0n;
    for (const [i, q] of ['2026Q1', '2026Q2', '2026Q3', '2026Q4'].entries()) {
      await h.sim.setTime(parsePeriod(q).end + DAY);
      await h.reportAndPay(seriesId, q, privateTerms, terms.termsCommitment, prev, ytd[i]!);
      prev = ytd[i]!;
    }
    const redeem = (maxPrice: number, who = h.issuer) => () => h.exec(who, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(maxPrice).toString() });
    await refused(h, redeem(100), 'LockupActive');
    await h.sim.setTime(settledAt + 365 * DAY + 10);
    await refused(h, redeem(100, h.backers[0]!), 'NotIssuer');
    // 2027Q1 has not ended, so no ended period is unreported
    const quote = h.sim.engine.quote(seriesOf(h.sim, seriesId), await h.sim.now());
    // hurdle 9 × 1.08 = 9.72; the 2026Q4 payment is tagged with settlement year 1 (its deadline 2027-01-31), so year 0
    // has no gross and k × D_avg = 0 (G6; was payoutTerm 20); C_rem = 22.5 − 4 = 18.5 → the hurdle decides (G6; was
    // 18.5 decided by the cap)
    expect(quote).toMatchObject({ pHurdle: USDC(9.72), dAvg: 0n, cRemaining: USDC(18.5), pRedeem: USDC(9.72), decidedBy: 'hurdle', tailCapPerUnit: USDC(8.78), deposit: USDC(4_860) });
    // our slippage bound (no Stage 1 name); 18 now covers the price (G6; was InvalidTerms)
    await expectChainError(redeem(9.71)(), 'InvalidTerms');
    const issuerBefore = await balance(h, h.issuer.address);
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(18).toString() });
    expect(types(r.events)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const now = await h.sim.now();
    const red = (await h.sim.getRedemption(seriesId))!;
    // deposit 4,860 (G6; was 9,250), tail cap 8.78 per unit (G6; was 0), tail window 365 days (RD; was 360)
    expect(red).toMatchObject({ pricePerUnit: USDC(9.72).toString(), deposit: USDC(4_860).toString(), unitsAtRedemption: '500', tailCapPerUnit: USDC(8.78).toString(), tailEndsAt: now + 365 * DAY, tailExhausted: false });
    expect(issuerBefore - (await balance(h, h.issuer.address))).toBe(USDC(4_860));
    // the deposit sits in the vault beside the 1,900 net payout (RD; was 1,900 only)
    expect((await h.sim.getVault(seriesId))!.balance).toBe(USDC(6_760).toString());
    // nobody has redeemed yet: redeemedUnits is set when a holder claims (RD; was 100 for everyone at redeem)
    expect((await h.sim.getPosition(seriesId, h.backers[0]!.address))!.redeemedUnits).toBe('0');
    await refused(h, redeem(100), 'TerminalStatus');

    const before = await balance(h, h.backers[0]!.address);
    const c = await h.exec(h.backers[0]!, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    // 9.72 × 100 = 972 (G6; was 1,850) + the 380 net payout
    expect((await balance(h, h.backers[0]!.address)) - before).toBe(USDC(972) + USDC(380));
    expect((await h.sim.getPosition(seriesId, h.backers[0]!.address))!).toMatchObject({ units: '0', redeemedUnits: '100' });

    // 2027Q1 liquidity event: 10% × (1,000,000 − 60,000) = 94,000 due at report (G5 + G6; was refused NoTailDue)
    await h.sim.setTime(parsePeriod('2027Q1').end + DAY);
    const ledger = h.sim.stage1View(seriesId).ledger;
    const issuer0 = await balance(h, h.issuer.address);
    const tail = await h.reportAndPay(seriesId, '2027Q1', privateTerms, terms.termsCommitment, 0n, USDC(1_000_000), { liquidityEvent: true });
    expect([tail.due, tail.paid]).toEqual([USDC(94_000), USDC(94_000)]);
    // at pay the tail cap takes 8.78 × 500 = 4,390, 89,610 goes back to the issuer, fee 219.5; no sync after a tail pay
    expect(types(tail.events)).toEqual(['ReportAccepted', 'PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'TailPayout']);
    const payload = (t: string) => tail.events.find((e) => e.type === t)!.payload as Record<string, unknown>;
    expect(payload('PaymentRefunded')).toMatchObject({ amount: USDC(89_610).toString(), reason: 'cap' });
    expect(payload('FeeTaken')).toMatchObject({ amount: USDC(219.5).toString() });
    expect(payload('PaymentReceived')).toMatchObject({ source: 'tail', gross: USDC(4_390).toString(), fee: USDC(219.5).toString(), net: USDC(4_170.5).toString() });
    expect(payload('TailPayout')).toMatchObject({ perUnit: USDC(8.78).toString(), total: USDC(4_390).toString() });
    expect(issuer0 - (await balance(h, h.issuer.address))).toBe(USDC(4_390));
    expect((await h.sim.getRedemption(seriesId))!).toMatchObject({
      tailExhausted: true, tailRefunded: USDC(89_610).toString(), tailPaidPerUnitWad: (USDC(8.78) * WAD).toString(), tailPaidPerUnit: USDC(8.78).toString(), tailAccWad: (USDC(8.341) * WAD).toString(),
    });
    // the tail never enters the payout vault's figures (Stage 1 keeps it in the tail state); our life-to-date totals count it
    const after = h.sim.stage1View(seriesId).ledger;
    expect([after.grossReceived, after.feeCollected, after.paidPerUnitWad]).toEqual([ledger.grossReceived, ledger.feeCollected, ledger.paidPerUnitWad]);
    expect([after.grossReceived, after.feeCollected]).toEqual([USDC(2_000).toString(), USDC(100).toString()]);
    expect((await h.sim.getVault(seriesId))!.grossTotal).toBe(USDC(6_390).toString());

    // b0 redeemed: its tail is 8.341 × 100 = 834.1
    expect((await h.sim.getPosition(seriesId, h.backers[0]!.address))!.tailClaimable).toBe(USDC(834.1).toString());
    const b0 = await balance(h, h.backers[0]!.address);
    await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect((await balance(h, h.backers[0]!.address)) - b0).toBe(USDC(834.1));
    // b1 has not redeemed yet: its position shows the same 834.1, the tail on the units its redemption would redeem
    // (TV; was 0). claimPayout pays it once b1 redeemed: 972 + 380 + 834.1 = 2,186.1 in all (Stage 1's claim_tail)
    expect((await h.sim.getPosition(seriesId, h.backers[1]!.address))!.tailClaimable).toBe(USDC(834.1).toString());
    const b1 = await balance(h, h.backers[1]!.address);
    await h.exec(h.backers[1]!, { kind: 'claimRedemption', seriesId });
    await h.exec(h.backers[1]!, { kind: 'claimPayout', seriesId });
    expect((await balance(h, h.backers[1]!.address)) - b1).toBe(USDC(2_186.1));

    // the tail is used up: a liquidity report is refused (G5); an ordinary one is accepted with nothing due
    await h.sim.setTime(parsePeriod('2027Q2').end + DAY);
    await expectStage1Error(h.reportAndPay(seriesId, '2027Q2', privateTerms, terms.termsCommitment, USDC(1_000_000), USDC(2_000_000), { liquidityEvent: true }), 'NoTailDue');
    const plain = await h.reportAndPay(seriesId, '2027Q2', privateTerms, terms.termsCommitment, USDC(1_000_000), USDC(2_000_000));
    expect([plain.due, plain.paid]).toEqual([0n, 0n]);
  });

  it('pays a capped tail when redemption was bound by the hurdle', async () => {
    const { h, seriesId, terms, privateTerms, settledAt } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000));
    await h.sim.setTime(Math.max(settledAt + 31 * DAY, parsePeriod('2026Q1').end + 2 * DAY));
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(10).toString() });
    const opened = r.events[0]!.payload as { pricePerUnit: string; tailCapPerUnit: string; deposit: string };
    // hurdle-bound, < 1 year → linear accrual: 9 × (1 + 0.08 × 88/365) (unchanged); C_rem = 22.5
    expect(opened).toMatchObject({ pricePerUnit: '9173589', tailCapPerUnit: '13326411', deposit: '4586794500' });
    const tailCap = BigInt(opened.tailCapPerUnit);
    // Q2 liquidity event: 10% × (2,000,000 − 60,000) = 194,000 due at report (G5; was capped at report to 6,663,205,500)
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    const tail = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(2_000_000), { liquidityEvent: true });
    expect(tail.due).toBe(USDC(194_000));
    expect(tail.due).toBe(tail.paymentStable);
    // at pay: the tail cap accepts 13.326411 × 500 = 6,663.2055, refunds 187,336.7945 to the issuer, fee 333.160275
    const payout = tail.events.find((e) => e.type === 'TailPayout')!.payload as { total: string };
    expect(BigInt(payout.total)).toBe(tailCap * 500n);
    expect(BigInt(payout.total)).toBe(6_663_205_500n);
    const refund = tail.events.find((e) => e.type === 'PaymentRefunded')!.payload as { amount: string; reason: string };
    expect([BigInt(refund.amount), refund.reason]).toEqual([187_336_794_500n, 'cap']);
    const fee = tail.events.find((e) => e.type === 'FeeTaken')!.payload as { amount: string };
    expect(BigInt(fee.amount)).toBe(333_160_275n);
    // b0 has not redeemed: its tail is paid after its redemption (RD), and its position shows it already on the units
    // that redemption would redeem (TV; was 0)
    expect((await h.sim.getPosition(seriesId, h.backers[0]!.address))!.tailClaimable).toBe('1266009045');
    const b0 = await balance(h, h.backers[0]!.address);
    await h.exec(h.backers[0]!, { kind: 'claimRedemption', seriesId });
    // 9.173589 × 100; no catch-up (its tail cursor is still 0, so the next claim pays the whole slice)
    expect((await balance(h, h.backers[0]!.address)) - b0).toBe(917_358_900n);
    const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
    expect(BigInt(pos.tailClaimable)).toBe(1_266_009_045n); // (6,663,205,500 − 5%) / 5, unchanged
    await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect((await balance(h, h.backers[0]!.address)) - b0).toBe(917_358_900n + 1_266_009_045n);
    // the cap is used up: a second liquidity-event report is refused (Stage 1 NoTailDue)
    await h.sim.setTime(parsePeriod('2026Q3').end + DAY);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(2_000_000), USDC(3_000_000), { liquidityEvent: true }), 'NoTailDue');
  });

  it('checks redeem in Stage 1 order; a paused series may redeem', async () => {
    const { h, seriesId, privateTerms, settledAt } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    const send = (id = seriesId, who = h.issuer) => () => h.exec(who, { kind: 'redeem', seriesId: id, maxPricePerUnit: USDC(100).toString() });
    // a second series of the same issuer, still in Draft
    const draft = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const draftId = (draft.events[0]!.payload as { seriesId: string }).seriesId;
    await refused(h, send(draftId, h.backers[0]!), 'NotIssuer');
    await refused(h, send(draftId), 'RaiseNotSettled');
    await h.sim.setTime(settledAt + 10 * DAY);
    await refused(h, send(), 'LockupActive'); // (TooEarly before; now with its Stage 1 name)
    // 2026Q1 has ended and is not reported
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await refused(h, send(), 'UnreportedPeriods');
    // 100,000 YTD → 4,000 due, left unpaid
    const q1 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await h.exec(h.issuer, q1.command);
    await refused(h, send(), 'PaymentOutstanding');
    const live = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: (BigInt(live.paymentDue) - BigInt(live.paid)).toString() });
    // 2026Q2 ended unreported 46 days ago: Late, refused before the unreported period is looked at
    await h.sim.setTime(parsePeriod('2026Q2').end + 46 * DAY);
    await refused(h, send(), 'SeriesLate');
    const q2 = await h.buildReport({ seriesId, periodId: '2026Q2', privateTerms, incomeYtdNow: USDC(100_000) });
    await h.exec(h.issuer, q2.command); // nothing more owed → OnTime again
    // an approved hardship pause covers now: Paused does not block a redemption (RD; was WrongStatus)
    const now = await h.sim.now();
    seedPause(h.sim, seriesId, now - DAY, now + 60 * DAY);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    // the sync point stores Paused first, then the redemption
    expect(types(r.events)).toEqual(['StatusChanged', 'RedemptionOpened', 'StatusChanged']);
    expect(r.events.map((e) => (e.payload as { to?: string }).to)).toEqual(['Paused', undefined, 'Redeemed']);
    await refused(h, send(), 'TerminalStatus');
  });

  it('retires instead when nothing is left of the cap', async () => {
    const { h, seriesId } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    await h.sim.setTime(Date.UTC(2026, 1, 10) / 1000);
    // white-box: the vault has paid the full cap per unit (an amendment lowering the cap reaches this state)
    seedVault(h.sim, seriesId, { paidPerUnitWad: USDC(22.5) * WAD });
    const issuer = await balance(h, h.issuer.address);
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: '0' });
    expect(types(r.events)).toEqual(['StatusChanged', 'SeriesRetired']);
    expect((await h.sim.getSeries(seriesId))!).toMatchObject({ status: 'Retired', redemption: null });
    expect(await balance(h, h.issuer.address)).toBe(issuer);
  });

  it('counts the tail owed to holders that have not redeemed in their positions and the vault dust (TV)', async () => {
    const { h, seriesId, terms, privateTerms, settledAt } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    const b0 = h.backers[0]!;
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000));
    await h.sim.setTime(Math.max(settledAt + 31 * DAY, parsePeriod('2026Q1').end + 2 * DAY));
    for (const b of h.backers) await h.exec(b, { kind: 'claimPayout', seriesId });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(10).toString() });
    const price = BigInt((await h.sim.getRedemption(seriesId))!.pricePerUnit);
    // b0 redeems 60 units while 40 are held for a window ask (white-box), then the ask returns them: 60 redeemed, 40 to go
    seedHolder(h.sim, seriesId, b0.address, { escrowed: 40n });
    await h.exec(b0, { kind: 'claimRedemption', seriesId });
    seedHolder(h.sim, seriesId, b0.address, { escrowed: 0n });
    // 2026Q2 liquidity event, paid before anyone else claims: net 6,330,045,225 into the vault, 12.66009045 per unit
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(2_000_000), { liquidityEvent: true });
    expect(seriesOf(h.sim, seriesId).tail.tailAccWad).toBe(12_660_090_450_000_000_000_000_000n);

    // positions: Stage 1's claimableTail view (MercesVault.sol:747-753; Exit.t.sol:227-229) and what claim_tail pays
    // (SIM:1403-1417): on the redeemed units, or, for a holder that has not redeemed, on the units its redemption would
    // redeem (claim_tail redeems first). `claimable` stays the net payout only (M9).
    const pos = async (w: string) => (await h.sim.getPosition(seriesId, w))!;
    for (const b of h.backers.slice(1)) expect(await pos(b.address)).toMatchObject({ claimable: '0', redeemedUnits: '0', tailClaimable: '1266009045', finalClaimable: '0' });
    expect(await pos(b0.address)).toMatchObject({ claimable: '0', redeemedUnits: '60', tailClaimable: '759605427' });

    // the vault: every holder's redemption and the whole tail it is owed are claims, so the dust is what is left once
    // everyone has claimed (it held the tail on every unit not yet redeemed: 440 × 12.66009045)
    const vault = (await h.sim.getVault(seriesId))!;
    const owed = price * 400n + price * 40n + 1_266_009_045n * 5n;
    expect(BigInt(vault.balance) - BigInt(vault.dust)).toBe(owed);
    // b0 takes the tail on its 60 redeemed units (the view's figure), then redeems its 40 with the catch-up on them
    let before = await balance(h, b0.address);
    await h.exec(b0, { kind: 'claimPayout', seriesId });
    expect((await balance(h, b0.address)) - before).toBe(759_605_427n);
    before = await balance(h, b0.address);
    await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect((await balance(h, b0.address)) - before).toBe(price * 40n + 506_403_618n);
    // the others redeem (no catch-up: their tail cursors are 0), then claimPayout pays the tail their position showed
    for (const b of h.backers.slice(1)) {
      before = await balance(h, b.address);
      await h.exec(b, { kind: 'claimRedemption', seriesId });
      await h.exec(b, { kind: 'claimPayout', seriesId });
      expect((await balance(h, b.address)) - before).toBe(price * 100n + 1_266_009_045n);
      expect(await pos(b.address)).toMatchObject({ units: '0', redeemedUnits: '100', tailClaimable: '0' });
    }
    expect((await h.sim.getVault(seriesId))!.balance).toBe(vault.dust);
  });

  it('redeems the units not held for a window ask, pays the tail catch-up, and refuses non-holders', async () => {
    const { h, seriesId } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    await h.sim.setTime(Date.UTC(2026, 1, 10) / 1000);
    await refused(h, () => h.exec(b0, { kind: 'claimRedemption', seriesId }), 'NotRedeemed');
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    const price = BigInt((await h.sim.getRedemption(seriesId))!.pricePerUnit);
    await refused(h, () => h.exec(h.attestors[0]!, { kind: 'claimRedemption', seriesId }), 'HolderNotRegistered');

    // 40 of b0's 100 units are held for a window ask: only 60 are redeemed and burned (Stage 1 burns the balance)
    seedHolder(h.sim, seriesId, b0.address, { escrowed: 40n });
    const vault = BigInt((await h.sim.getVault(seriesId))!.balance);
    const c = await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toEqual(['UnitsBurned', 'RedemptionClaimed']);
    expect(c.events[1]!.payload).toMatchObject({ units: '60', amount: (price * 60n).toString() });
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '40', redeemedUnits: '60' });
    expect(BigInt((await h.sim.getVault(seriesId))!.balance)).toBe(vault - price * 60n);
    expect((await h.sim.getRedemption(seriesId))!.claimed).toBe((price * 60n).toString());
    // nothing left to redeem: a claim of 0 units is allowed
    const z = await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect(types(z.events)).toEqual(['RedemptionClaimed']);
    expect(z.events[0]!.payload).toMatchObject({ units: '0', amount: '0' });

    // white-box tail catch-up (Stage 1 S6): b1's tail cursor sits at 1.234567890123456789012345 per unit, the tail at 1.5.
    // Redeeming 100 units pays the [0, cursor] slice now, floor(cursor × 100 / WAD), and leaves the cursor where it is,
    // so the next claim pays the [cursor, tail] slice: 123,456,789 + 26,543,210 (one base unit lost to the floors).
    seedTail(h.sim, seriesId, { tailAccWad: USDC(1.5) * WAD });
    seedVault(h.sim, seriesId, { balance: seriesOf(h.sim, seriesId).vaultBalance + USDC(150) });
    const cursor = 1_234_567_890_123_456_789_012_345n;
    seedHolder(h.sim, seriesId, b1.address, { lastTailAccWad: cursor });
    const before = await balance(h, b1.address);
    const c1 = await h.exec(b1, { kind: 'claimRedemption', seriesId });
    expect(types(c1.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    expect(c1.events[0]!.payload).toMatchObject({ amount: '123456789' });
    expect((await balance(h, b1.address)) - before).toBe(price * 100n + 123_456_789n);
    expect(seriesOf(h.sim, seriesId).positions.get(b1.address)!.lastTailAccWad).toBe(cursor);
    expect((await h.sim.getPosition(seriesId, b1.address))!.tailClaimable).toBe('26543210');
    await h.exec(b1, { kind: 'claimPayout', seriesId });
    expect((await balance(h, b1.address)) - before).toBe(price * 100n + 149_999_999n);
  });
});

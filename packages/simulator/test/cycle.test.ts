import { describe, expect, it } from 'vitest';
import { DAY, WAD, mulDiv, parsePeriod, toPid } from '@merces/math';
import { SimHarness, type Personality } from '../src/index.ts';
import { DEFAULTS } from '@merces/domain';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

/*
 * S2 cause codes:
 *  - S2-PR: push delivery (`deliverBid`; `claimRefund` retired): the harness raise delivers every bid's units and refund.
 */
for (const personality of ['solana', 'monad'] as Personality[]) {
  describe(`simulator (${personality}) full raise-to-payout cycle`, () => {
    it('runs auction → treasury → reports → payouts → claims with correct money', async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId, terms, privateTerms } = await h.runRaise();
      const series = (await h.sim.getSeries(seriesId))!;
      // 5 bids of 100 units at 12,11,10,10,9 for 500 units offered (harness wallet cap 20% = 100): all fill, clearing at 9
      expect(series.phase).toBe('Settled');
      expect(series.issuePrice).toBe(USDC(9).toString());
      expect(series.unitsOutstanding).toBe('500');
      expect(series.capPerUnit).toBe(USDC(22.5).toString());
      const treasury = (await h.sim.getTreasury(seriesId))!;
      expect(treasury.total).toBe(USDC(4500).toString());
      // auction fee 1% of 4500 = 45 at the fee collector
      expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDC')).toBe(USDC(45).toString());
      // winners get their excess deposit back (cause S2-PR: delivered by the harness raise, no claimRefund)
      const bid0 = (await h.sim.getBid(seriesId, h.backers[0]!.address))!;
      expect(bid0.allocatedUnits).toBe('100');
      const bal0 = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
      expect(bal0).toBe(1_000_000_000_000n - USDC(900) - USDC(9));

      // treasury release: tranche 0 drawable immediately, no approval needed (C11.1)
      const drew = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
      expect(types(drew.events)).toEqual(['FundsReleased']);
      expect((await h.sim.getTreasury(seriesId))!.released).toBe(USDC(2250).toString());
      await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'TooEarly');

      // Q1 2026: income 25k YTD → zero payment is a complete report
      await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
      const q1 = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(25_000));
      expect(q1.due).toBe(0n);
      expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.settled).toBe(true);
      await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'TooEarly'); // 90-day tranche not yet due on 2 April

      // Q2: 50k YTD, still below threshold
      await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
      const q2 = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(25_000), USDC(50_000));
      expect(q2.due).toBe(0n);
      const drew2 = await h.exec(h.issuer, { kind: 'drawRelease', seriesId }); // 90-day tranche
      expect(drew2.events.map((e) => (e.payload as { trancheIndex: number }).trancheIndex)).toEqual([1]);

      // Q3: 75k YTD → 10% × 15k = 1,500 gross; fee 75; net 1,425 to 500 units
      await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
      const q3 = await h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(50_000), USDC(75_000));
      expect(q3.paymentStable).toBe(USDC(1500));
      expect(types(q3.events)).toEqual(['ReportAccepted', 'FeeTaken', 'PaymentReceived']);
      const vault = (await h.sim.getVault(seriesId))!;
      expect(vault.balance).toBe(USDC(1425).toString());
      const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
      expect(pos.claimable).toBe(USDC(285).toString()); // 1425 × 100/500
      // Stage 1's vault: paid per unit 1500/500 = 3, net accumulator 1425/500 = 2.85, gross 1,500, fee 75; the open due
      // is closed and Q3 is the last paid period (2026Q3 = 8106)
      const v = h.sim.stage1View(seriesId).ledger;
      expect([v.paidPerUnitWad, v.netAccWad, v.carryWad, v.grossReceived, v.feeCollected, v.refundedToIssuer]).toEqual([(USDC(3) * WAD).toString(), (USDC(2.85) * WAD).toString(), '0', USDC(1500).toString(), USDC(75).toString(), '0']);
      expect([v.openDuePeriod, v.openDueAmount, v.lastPaidPeriod]).toEqual([null, '0', '8106']);
      const claimed = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
      expect(types(claimed.events)).toEqual(['PayoutClaimed']);
      // the claim moved the holder's cursor to the accumulator and emptied its pending balance
      expect(await h.sim.getPosition(seriesId, h.backers[0]!.address)).toMatchObject({ claimable: '0', pending: '0', lastAccWad: v.netAccWad, claimedTotal: USDC(285).toString() });
      // a second claim with nothing accrued is a successful no-op with no events (Stage 1's zero-amount rule, vector 21)
      expect((await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId })).events).toEqual([]);
      // a wallet with no registration is refused (Stage 1 HolderNotRegistered, code NotFound)
      await expectStage1Error(h.exec(h.issuer, { kind: 'claimPayout', seriesId }), 'HolderNotRegistered');
      await expectChainError(h.exec(h.issuer, { kind: 'claimPayout', seriesId }), 'NotFound');
      // nothing is due once paid (Stage 1 NothingDue); the burn crank needs a Retired series (TerminalStatus)
      await expectStage1Error(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q3', amount: '0' }), 'NothingDue');
      await expectStage1Error(h.sim.submit({ kind: 'crankBurn', seriesId, holders: [h.backers[1]!.address] }, 'keeper'), 'TerminalStatus');
      expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');

      // events are resumable from a cursor
      const first = await h.sim.readEvents(null, 5);
      expect(first.events).toHaveLength(5);
      const rest = await h.sim.readEvents(first.nextCursor, 1000);
      expect(rest.events[0]!.seq).toBe(6);
      expect(first.events.every((e) => e.chain === personality)).toBe(true);
    });

    it('payIn is Stage 1 pay: anyone pays the open due, exactly, with the accrual at payment; the year follows the report deadline', async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId, terms, privateTerms } = await h.runRaise();
      const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
      const report = async (periodId: string, ytd: bigint) => {
        const { command } = await h.buildReport({ seriesId, periodId, privateTerms, termsCommitment: terms.termsCommitment, incomeYtdNow: ytd });
        return BigInt((((await h.exec(h.issuer, command)).events[0]!.payload) as { paymentDue: string }).paymentDue);
      };
      // nothing reported yet: nothing is due (Stage 1 NothingDue), whatever the period or amount
      await expectStage1Error(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '0' }), 'NothingDue');
      // Q1 100k YTD on a 60k threshold: 10% × 40k = 4,000 due
      await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
      const due = await report('2026Q1', USDC(100_000));
      expect(due).toBe(USDC(4000));
      // our guards (no Stage 1 name): the period must be the open due one, the amount exactly the due
      await expectChainError(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q2', amount: due.toString() }), 'InvalidTerms');
      await expectChainError(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: (due + 1n).toString() }), 'InvalidTerms');
      // paid 60 days after the period end: 15 late days past report due + grace (45 days); Stage 1 lateAccrual
      await h.sim.setTime(parsePeriod('2026Q1').end + 60 * 86_400);
      const accrual = mulDiv(mulDiv(due, DEFAULTS.hurdleWad, WAD), 15n, 365n);
      const total = due + accrual;
      expect(await h.sim.getPeriod(seriesId, '2026Q1')).toMatchObject({ paymentDue: total.toString(), accrual: accrual.toString(), settled: false });
      await expectChainError(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: due.toString() }), 'InvalidTerms');
      // no issuer check: a backer pays the issuer's due; it alone is debited
      const payer = h.backers[4]!;
      const [payerBefore, issuerBefore] = [BigInt(await h.sim.getBalance(payer.address, 'USDC')), BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))];
      const paid = await h.exec(payer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: total.toString() });
      expect(types(paid.events)).toContain('PaymentReceived');
      const fee = (total * 500n) / 10_000n;
      expect(paid.events.find((x) => x.type === 'PaymentReceived')!.payload).toMatchObject({ periodId: '2026Q1', gross: total.toString(), fee: fee.toString(), net: (total - fee).toString(), source: 'payIn', paymentDue: total.toString(), accrual: accrual.toString() });
      expect(paid.events.find((x) => x.type === 'FeeTaken')!.payload).toMatchObject({ payer: payer.address, amount: fee.toString() });
      expect(BigInt(await h.sim.getBalance(payer.address, 'USDC'))).toBe(payerBefore - total);
      expect(BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))).toBe(issuerBefore);
      expect(await h.sim.getPeriod(seriesId, '2026Q1')).toMatchObject({ paymentDue: total.toString(), accrual: accrual.toString(), paid: total.toString(), settled: true });
      const l = h.sim.stage1View(seriesId).ledger;
      expect([l.grossReceived, l.feeCollected, l.lastPaidPeriod, l.openDueAmount]).toEqual([total.toString(), fee.toString(), String(toPid('2026Q1')), '0']);
      await expectStage1Error(h.exec(payer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '0' }), 'NothingDue');
      // the settlement year comes from the period's report deadline (period end + 30 days), not from the payment time:
      // Q4 2026 paid on 2 January 2027 is still year 0 by the clock but year 1 by its deadline
      for (const q of ['2026Q2', '2026Q3']) {
        await h.sim.setTime(parsePeriod(q).end + 86_400);
        expect(await report(q, USDC(100_000))).toBe(0n);
      }
      await h.sim.setTime(parsePeriod('2026Q4').end + 86_400);
      const now = await h.sim.now();
      expect(now - settledAt).toBeLessThan(365 * 86_400);
      expect(BigInt(parsePeriod('2026Q4').end) + 30n * DAY - BigInt(settledAt)).toBeGreaterThanOrEqual(365n * DAY);
      const q4 = await report('2026Q4', USDC(110_000));
      expect(q4).toBe(USDC(1000));
      await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q4', amount: q4.toString() });
      const years = (await h.sim.getSeries(seriesId))!.yearGross;
      expect(years.filter((y) => y.year !== null).map((y) => [y.year, y.grossWad])).toEqual([[0, (mulDiv(total, WAD, 500n)).toString()], [1, (mulDiv(q4, WAD, 500n)).toString()]]);
    });
  });
}

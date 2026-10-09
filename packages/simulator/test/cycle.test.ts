import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness, type Personality } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

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
      // winners get their excess deposit back
      const bid0 = (await h.sim.getBid(seriesId, h.backers[0]!.address))!;
      expect(bid0.allocatedUnits).toBe('100');
      await h.exec(h.backers[0]!, { kind: 'claimRefund', seriesId });
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
      const claimed = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
      expect(types(claimed.events)).toEqual(['PayoutClaimed']);
      await expectChainError(h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId }), 'NotFound');
      expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');

      // events are resumable from a cursor
      const first = await h.sim.readEvents(null, 5);
      expect(first.events).toHaveLength(5);
      const rest = await h.sim.readEvents(first.nextCursor, 1000);
      expect(rest.events[0]!.seq).toBe(6);
      expect(first.events.every((e) => e.chain === personality)).toBe(true);
    });
  });
}

import { describe, expect, it } from 'vitest';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

/*
 * S3 cause codes:
 *  - S3-FN: the final-pool share is `claimFinal`'s (`FinalClaimed`, then the burn; was paid by `claimPayout`).
 */
describe('curve mode (solana)', () => {
  async function curveSeries() {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    return { h, seriesId: (created.events[0]!.payload as { seriesId: string }).seriesId };
  }

  it('only allowlisted wallets can buy before graduation', async () => {
    const { h, seriesId } = await curveSeries();
    const stranger = h.sim.address('wallet:curve-stranger');
    await h.sim.fund(stranger, 'USDC', USDC(10_000));
    const tx = await h.sim.build({ kind: 'buyCurve', seriesId, amountIn: USDC(100).toString(), minUnitsOut: '0' }, stranger);
    await expectChainError(h.sim.send({ tx, signatures: { [stranger]: `sim:${stranger}` } }), 'NotAllowlisted');
    await h.sim.submit({ kind: 'setAllowlist', wallet: h.backers[0]!.address, allowed: false }, 'allowlistManager');
    await expectChainError(h.exec(h.backers[0]!, { kind: 'buyCurve', seriesId, amountIn: USDC(100).toString(), minUnitsOut: '0' }), 'NotAllowlisted');
    const ok = await h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(100).toString(), minUnitsOut: '0' });
    expect(types(ok.events)).toEqual(['UnitsMinted', 'TreasuryFunded']);
  });

  // Stage 1 extinguishes only a settled raise (exit.rs:229-236, SIM:1425): an ungraduated curve has not settled, so it is
  // refused (cause M5: the owner adopted Stage 1's rule; was "the whole treasury goes back to the curve buyers")
  it('refuses to extinguish an ungraduated curve; once graduated, holders share its unvested treasury', async () => {
    const { h, seriesId } = await curveSeries();
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const extinguish = () => h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    await h.exec(h.backers[0]!, { kind: 'buyCurve', seriesId, amountIn: USDC(1000).toString(), minUnitsOut: '0' });
    await h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    await expectStage1Error(extinguish(), 'RaiseNotSettled'); // M5: was PaymentReceived + SeriesExtinguished
    // the curve keeps selling and graduates as usual
    const buy = await h.exec(h.backers[2]!, { kind: 'buyCurve', seriesId, amountIn: USDC(600).toString(), minUnitsOut: '0' });
    expect(types(buy.events)).toEqual(['UnitsMinted', 'TreasuryFunded', 'CurveGraduated']);
    // the event carries the issue price graduation stored (raised / units sold), the base of the cap per unit
    const graduated = (await h.sim.getSeries(seriesId))!;
    expect(buy.events[2]!.payload).toEqual({ seriesId, raised: USDC(2100).toString(), unitsOutstanding: graduated.unitsOutstanding, issuePrice: graduated.issuePrice });
    expect(graduated.issuePrice).toBe((USDC(2100) / BigInt(graduated.unitsSold)).toString());
    // a graduated curve is a settled raise: only the unvested half of its 2,100 treasury goes to the final pool (G7)
    const ex = await extinguish();
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    expect((ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(1050).toString());
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.final.units).toBe(s.unitsOutstanding);
    // every buyer was registered at graduation and claims its pro-rata share; its units burn on the final claim
    let claimed = 0n;
    for (const b of [h.backers[0]!, h.backers[1]!, h.backers[2]!]) {
      const units = BigInt((await h.sim.getPosition(seriesId, b.address))!.units);
      const claim = await h.exec(b, { kind: 'claimFinal', seriesId }); // cause S3-FN (was claimPayout)
      expect(types(claim.events)).toEqual(['FinalClaimed', 'UnitsBurned']);
      const amount = BigInt((claim.events[0]!.payload as { amount: string }).amount);
      expect(amount).toBe((USDC(1050) * units) / BigInt(s.unitsOutstanding));
      claimed += amount;
    }
    expect(USDC(1050) - claimed).toBeLessThan(3n); // flooring dust only
  });

  it('refuses to extinguish a curve nobody bought', async () => {
    const { h, seriesId } = await curveSeries();
    // M5: was RaiseCancelled + SeriesExtinguished
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]), 'RaiseNotSettled');
  });
});

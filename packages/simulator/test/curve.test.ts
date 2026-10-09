import { describe, expect, it } from 'vitest';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

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

  it('extinguishing an ungraduated curve returns the treasury to holders and refuses further buys and graduation', async () => {
    const { h, seriesId } = await curveSeries();
    const backer = h.backers[0]!;
    const before = BigInt(await h.sim.getBalance(backer.address, 'USDC'));
    await h.exec(backer, { kind: 'buyCurve', seriesId, amountIn: USDC(1000).toString(), minUnitsOut: '0' });
    await h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    const ex = await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    expect(ex.events[0]!.payload).toMatchObject({ source: 'extinguishment', gross: USDC(1500).toString(), fee: '0' });
    expect((ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(1500).toString());
    // the holder recovers its pro-rata share of the treasury and its units burn on claim
    const claim = await h.exec(backer, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    const recovered = BigInt(await h.sim.getBalance(backer.address, 'USDC')) - (before - USDC(1000));
    expect(recovered).toBeGreaterThan(0n);
    expect(recovered).toBeLessThanOrEqual(USDC(1500));
    // nothing more can enter or graduate an extinguished curve
    await expectChainError(h.exec(h.backers[2]!, { kind: 'buyCurve', seriesId, amountIn: USDC(5000).toString(), minUnitsOut: '0' }), 'WrongStatus');
    await expectChainError(h.sim.submit({ kind: 'graduateCurve', seriesId }, 'keeper'), 'WrongStatus');
  });

  it('extinguishing a curve nobody bought simply cancels it', async () => {
    const { h, seriesId } = await curveSeries();
    const ex = await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    expect(types(ex.events)).toEqual(['RaiseCancelled', 'SeriesExtinguished', 'StatusChanged']);
  });
});

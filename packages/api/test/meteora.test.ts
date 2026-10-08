import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { defaultTerms } from '@merces/simulator';
import { defaultMeteoraProviders } from '@merces/services';
import type { UnsignedTx } from '@merces/domain';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe.skipIf(!dbTestsEnabled())('M6 Meteora support (E14)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('configures a curve-mode series, quotes buys (USDC and via a USDG swap route), monitors and graduates it', async () => {
    const h = rig.sol;
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const backerTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    // monad has no curve mode
    const monSeries = (await rig.mon.runRaise()).seriesId;
    expect((await rig.get(`/series/${monSeries}/curve`)).statusCode).toBe(422);
    const st0 = await rig.get(`/series/${seriesId}/curve`);
    expect(st0.json().configured).toBe(false);
    expect(st0.json().notice).toContain('live public price');
    expect((await rig.post(`/series/${seriesId}/curve/configure`, {}, backerTok)).statusCode).toBe(403);
    const cfg = await rig.post(`/series/${seriesId}/curve/configure`, {}, issuerTok);
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().tokenBadgeRequired).toBe(false);
    expect(cfg.json().params.migrationQuoteThreshold).toBe(USDC(2000).toString());
    // a USDG buyer gets a swap route first, then the curve buy
    const viaUsdg = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(1000).toString(), payIn: 'USDG', slippageBps: 50 }, backerTok);
    expect(viaUsdg.statusCode).toBe(200);
    expect(viaUsdg.json().swap.quote.outAmount).toBe('999500000');
    expect(viaUsdg.json().swap.transactionBase64).toBeTruthy();
    expect(viaUsdg.json().tx.command.kind).toBe('buyCurve');
    // buy with USDC through the builder and relay; mirror into the mock pool
    const buy = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(1500).toString(), payIn: 'USDC' }, backerTok);
    expect(BigInt(buy.json().minUnitsOut)).toBeGreaterThan(0n);
    const sent = await rig.post('/tx/send', await h.backers[0]!.sign(buy.json().tx as UnsignedTx), backerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const minted = sent.json().events.find((e: { type: string }) => e.type === 'UnitsMinted');
    defaultMeteoraProviders.meteora.applyBuy(cfg.json().pool, USDC(1500), BigInt(minted.payload.units));
    let mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json()).toEqual({ checked: 1, graduated: [] });
    const st1 = await rig.get(`/series/${seriesId}/curve`);
    expect(st1.json().onchain.graduated).toBe(false);
    expect(st1.json().pool.progressBps).toBe(7500);
    // second buy crosses the threshold: the simulator graduates on the buy; the monitor records it
    const buy2 = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[1]!.address, amountIn: USDC(600).toString(), payIn: 'USDC' }, rig.token({ accountId: 'b1', wallets: [{ chain: 'solana', address: h.backers[1]!.address }], roles: ['backer'] }));
    const sent2 = await rig.post('/tx/send', await h.backers[1]!.sign(buy2.json().tx as UnsignedTx), rig.token({ accountId: 'b1', wallets: [{ chain: 'solana', address: h.backers[1]!.address }], roles: ['backer'] }));
    expect(sent2.json().events.map((e: { type: string }) => e.type)).toContain('CurveGraduated');
    mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json().graduated).toEqual([]);
    await rig.sync();
    const st2 = await rig.get(`/series/${seriesId}/curve`);
    expect(st2.json().onchain.graduated).toBe(true);
    expect((await rig.get(`/series/${seriesId}`)).json().phase).toBe('Settled');
    expect((await rig.get(`/series/${seriesId}`)).json().curve.graduated).toBe(true);
    expect((await rig.post('/admin/curves/monitor', {}, backerTok)).statusCode).toBe(403);
  });
});

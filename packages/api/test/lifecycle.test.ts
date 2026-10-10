import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { setFlag } from '@merces/core';
import { orderCommitment, type UnsignedTx } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe.skipIf(!dbTestsEnabled())('lifecycle builders (R6, R13, R14, R15, R19)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('treasury draw, payout claim, redemption quote → redeem → claim, tail view, retirement view, windows gated by the flag', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { lockupSeconds: 365 * 86_400 } });
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'iss', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'monad', address: h.backers[0]!.address }], roles: ['backer'] });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    // R6: draw the first tranche through the builder; a second draw is refused until the next tranche
    const draw = await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok);
    expect(draw.json().drawable).toEqual([{ index: 0, amount: USDC(2250).toString() }]);
    expect((await rig.post('/tx/send', await h.issuer.sign(draw.json().tx as UnsignedTx), issuerTok)).statusCode).toBe(200);
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).statusCode).toBe(409);
    const pause = await rig.post(`/series/${seriesId}/treasury/build-pause`, { paused: true }, issuerTok);
    await rig.post('/tx/send', await h.issuer.sign(pause.json().tx as UnsignedTx), issuerTok);
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).json().message).toContain('paused by the issuer');
    await rig.post('/tx/send', await h.issuer.sign((await rig.post(`/series/${seriesId}/treasury/build-pause`, { paused: false }, issuerTok)).json().tx as UnsignedTx), issuerTok);
    // a year of modest payments (80k/yr → 2,000 gross/yr = 4 per unit)
    const ytd = [20_000, 40_000, 60_000, 80_000].map(USDC);
    let prev = 0n;
    for (const [i, q] of ['2026Q1', '2026Q2', '2026Q3', '2026Q4'].entries()) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      await h.reportAndPay(seriesId, q, raise.privateTerms, raise.terms.termsCommitment, prev, ytd[i]!);
      prev = ytd[i]!;
    }
    await rig.sync();
    // R13: claim through the builder
    expect((await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, issuerTok)).statusCode).toBe(403);
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(claim.json().builder).toBe('public');
    expect(claim.json().claimable).toBe((USDC(2000) * 95n / 100n / 5n).toString());
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(claim.json().tx as UnsignedTx), holderTok)).json().events[0].type).toBe('PayoutClaimed');
    expect((await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok)).statusCode).toBe(409);
    // R14 retirement view (not retired)
    const ret = await rig.get(`/series/${seriesId}/retirement`);
    expect(ret.json()).toMatchObject({ retired: false, paidPerUnit: USDC(4).toString(), capProgressBps: Math.floor((4 / 22.5) * 10_000) });
    // R15: quote before lockup end lists the blocker; after a full year the hurdle decides (matches the simulator test)
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    let quote = await rig.get(`/series/${seriesId}/redemption/quote`, holderTok);
    expect(quote.json().blockers.some((b: string) => b.includes('lockup'))).toBe(true);
    expect((await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(100).toString() }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(settledAt + 365 * 86_400 + 10);
    quote = await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
    // Stage 1's quote over the year ring: the 2026Q4 payment is tagged with settlement year 1 (its deadline), so
    // k × D_avg = 0 and the hurdle 9.72 decides below C_rem 18.5 (G6; was 18.5 bound by the cap, payoutTerm 20, deposit 9,250)
    expect(quote.json()).toMatchObject({ redeemable: true, pricePerUnit: USDC(9.72).toString(), boundBy: 'hurdle', deposit: USDC(4_860).toString(), tailCapPerUnit: USDC(8.78).toString() });
    expect(quote.json().terms.hurdlePrice).toBe(USDC(9.72).toString());
    expect(quote.json().terms.payoutTerm).toBe('0');
    const redeem = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(9.72).toString() }, issuerTok);
    expect(redeem.statusCode).toBe(200);
    expect((await rig.post('/tx/send', await h.issuer.sign(redeem.json().tx as UnsignedTx), issuerTok)).json().events.map((e: { type: string }) => e.type)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const rc = await rig.post(`/series/${seriesId}/redemption/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(rc.json()).toMatchObject({ units: '100', amount: USDC(972).toString() }); // 9.72 × 100 (G6; was 1,850)
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(rc.json().tx as UnsignedTx), holderTok)).statusCode).toBe(200);
    await rig.sync();
    const red = await rig.get(`/series/${seriesId}/redemption`, holderTok);
    expect(red.json().status).toBe('Redeemed');
    expect(red.json().tail.open).toBe(true); // the hurdle decided: 18.5 − 9.72 = 8.78 per unit of tail room (G6; was closed)
    expect(red.json().claims.count).toBe(1);
    // R19: windows switched off → 403; on → builders work after lockup
    const win = await rig.get(`/series/${seriesId}/window`);
    expect(win.json().enabled).toBe(false);
    expect((await rig.post(`/series/${seriesId}/window/build-commit`, { wallet: h.backers[1]!.address, side: 'sell', commitment: '0x' + '00'.repeat(32), deposit: '0', units: '10' }, rig.token({ accountId: 'b1', wallets: [{ chain: 'monad', address: h.backers[1]!.address }], roles: ['backer'] }))).statusCode).toBe(403);
    await setFlag(rig.t.pool, 'transfer_windows', true, 'test');
    const other = await rig.mon.runRaise({ terms: { lockupSeconds: 10 } });
    await h.sim.advanceTime(11);
    const now = await h.sim.now();
    await h.sim.submit({ kind: 'openTransferWindow', seriesId: other.seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const b1 = h.backers[1]!;
    const b1Tok = rig.token({ accountId: 'b1', wallets: [{ chain: 'monad', address: b1.address }], roles: ['backer'] });
    const salt = '0x' + 'dd'.repeat(32);
    const c = orderCommitment({ seriesId: other.seriesId, windowId: 0, wallet: b1.address, side: 'sell', pricePerUnit: USDC(10), quantity: 10n, salt });
    const wc = await rig.post(`/series/${other.seriesId}/window/build-commit`, { wallet: b1.address, side: 'sell', commitment: c, deposit: '0', units: '10' }, b1Tok);
    expect(wc.statusCode).toBe(200);
    const wsent = await rig.post('/tx/send', await b1.sign(wc.json().tx as UnsignedTx), b1Tok);
    expect(wsent.statusCode, wsent.body).toBe(200);
    expect((await rig.put(`/series/${other.seriesId}/window/backup`, { wallet: b1.address, ciphertext: 'age:...' }, b1Tok)).statusCode).toBe(200);
    expect((await rig.get(`/series/${other.seriesId}/window`)).json().phase).toBe('commit');
    expect((await rig.post(`/series/${seriesId}/retirement/crank-burn`, {}, adminTok)).statusCode).toBe(409); // redeemed units burn on claim, not by crank
    await setFlag(rig.t.pool, 'transfer_windows', false, 'test');
  });
});

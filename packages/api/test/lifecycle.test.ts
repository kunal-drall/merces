import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { setFlag } from '@merces/core';
import { orderCommitment, type UnsignedTx } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * Pins that moved with Stage 1 (S1 WP12) carry a cause code. The figures were recomputed with Stage 1's own `Simulator`
 * (its `ScenarioBuilder`, the harness's terms: θ 60,000, 10% above it, 500 units at 9 USDC, cap 2.5×, hurdle 8%, k 2,
 * a 5% payout fee) over the same flow: tranche 0 drawn, 20/40/60/80k year to date reported a day after each 2026 quarter,
 * quote and redeem at settlement + 365 days + 10 s, b0 claims its redemption:
 *  - G6: Stage 1's `redemptionQuote` over the tagged year ring: the 2026Q4 payment is tagged with the settlement year of
 *    its deadline (2027-01-31, settlement year 1), so year 0 holds no gross, D_avg = 0 and the hurdle 9 × 1.08 = 9.72
 *    decides below C_rem = 22.5 − 4 = 18.5; deposit 4,860, tail cap 8.78, b0's claim 972;
 *  - C: Stage 1's zero-amount claim is a successful no-op (SIM:1268-1282): HTTP 200 with no events.
 * S3 cause codes:
 *  - S3-Z: the zero-amount rule: a claim of nothing succeeds and emits its event with zeros (`PayoutClaimed{0, 0}`);
 *  - S3-CL: the payout claim builder is Stage 1's `claim`: it returns what that claim pays (`claimable`) and the units it
 *    burns (`burnsUnits`), and its 409 (`nothing-to-claim`) names the claims that would pay the holder something;
 *  - S3-BR: the admin burn sends one `burnRetired` per holder still holding units, and refuses a series not Retired.
 */
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
    // cause S3-CL: what the claim pays and burns, nothing of the other pools (was: tailClaimable and finalClaimable too)
    expect(claim.json()).toMatchObject({ builder: 'public', claimable: (USDC(2000) * 95n / 100n / 5n).toString(), burnsUnits: '0' });
    expect(claim.json()).not.toHaveProperty('tailClaimable');
    expect(claim.json()).not.toHaveProperty('finalClaimable');
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(claim.json().tx as UnsignedTx), holderTok)).json().events[0].type).toBe('PayoutClaimed');
    const nothing = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ message: 'nothing to claim', detail: { reason: 'nothing-to-claim', claimWith: [] } });
    // the builder refuses a claim with nothing in it, but the chain takes one: relayed anyway, a zero claim succeeds
    // (cause C: was 404, ChainNotFound) and emits its event with zeros (cause S3-Z: was no event)
    const zero = await rig.post('/tx/send', await h.backers[0]!.sign(await h.sim.build({ kind: 'claimPayout', seriesId }, h.backers[0]!.address)), holderTok);
    expect(zero.statusCode, zero.body).toBe(200);
    expect(zero.json().events.map((e: { type: string; payload: unknown }) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: h.backers[0]!.address, amount: '0', burnedUnits: '0' }]]);
    // a wallet that is not a registered holder is still refused: 404 with Stage 1's HolderNotRegistered
    const notHolder = await rig.post('/tx/send', await h.issuer.sign(await h.sim.build({ kind: 'claimPayout', seriesId }, h.issuer.address)), issuerTok);
    expect(notHolder.statusCode).toBe(404);
    expect(notHolder.json()).toMatchObject({ error: 'ChainNotFound', detail: { stage1: 'HolderNotRegistered' } });
    // R14 retirement view (not retired)
    const ret = await rig.get(`/series/${seriesId}/retirement`);
    expect(ret.json()).toMatchObject({ retired: false, paidPerUnit: USDC(4).toString(), capProgressBps: Math.floor((4 / 22.5) * 10_000) });
    // R15: quote before lockup end lists the blocker; after a full year the hurdle decides (matches the simulator test)
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    let quote = await rig.get(`/series/${seriesId}/redemption/quote`, holderTok);
    expect(quote.json().blockers.some((b: string) => b.includes('lockup'))).toBe(true);
    expect(quote.json().blockedBy).toEqual(['LockupActive']); // Stage 1's error name beside the text
    expect((await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(100).toString() }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(settledAt + 365 * 86_400 + 10);
    quote = await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
    // Stage 1's quote over the year ring: the 2026Q4 payment is tagged with settlement year 1 (its deadline), so
    // k × D_avg = 0 and the hurdle 9.72 decides below C_rem 18.5 (G6; was 18.5 bound by the cap, payoutTerm 20, deposit 9,250)
    expect(quote.json()).toMatchObject({ redeemable: true, pricePerUnit: USDC(9.72).toString(), boundBy: 'hurdle', deposit: USDC(4_860).toString(), tailCapPerUnit: USDC(8.78).toString() });
    expect(quote.json()).toMatchObject({ decidedBy: 'hurdle', blockedBy: [], outcome: 'redeem', terms: { dAvg: '0', capRemaining: USDC(18.5).toString() } });
    expect(quote.json().terms.hurdlePrice).toBe(USDC(9.72).toString());
    expect(quote.json().terms.payoutTerm).toBe('0');
    const redeem = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(9.72).toString() }, issuerTok);
    expect(redeem.statusCode).toBe(200);
    expect((await rig.post('/tx/send', await h.issuer.sign(redeem.json().tx as UnsignedTx), issuerTok)).json().events.map((e: { type: string }) => e.type)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const rc = await rig.post(`/series/${seriesId}/redemption/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(rc.json()).toMatchObject({ units: '100', amount: USDC(972).toString() }); // 9.72 × 100 (G6; was 18.5 × 100 = 1,850)
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(rc.json().tx as UnsignedTx), holderTok)).statusCode).toBe(200);
    await rig.sync();
    const red = await rig.get(`/series/${seriesId}/redemption`, holderTok);
    expect(red.json().status).toBe('Redeemed');
    expect(red.json().tail.open).toBe(true); // the hurdle decided: 18.5 − 9.72 = 8.78 per unit of tail room (G6; was closed)
    // Stage 1's tail state: nothing paid yet, not exhausted
    expect(red.json().tail).toMatchObject({ capPerUnit: USDC(8.78).toString(), paidPerUnitWad: '0', paidPerUnit: '0', exhausted: false, refunded: '0' });
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
    // cause S3-BR: burnRetired takes a Retired series only; redeemed units burn at their redemption
    const burn = await rig.post(`/series/${seriesId}/retirement/crank-burn`, {}, adminTok);
    expect(burn.statusCode).toBe(409);
    expect(burn.json()).toMatchObject({ detail: { stage1: 'TerminalStatus' } });
    await setFlag(rig.t.pool, 'transfer_windows', false, 'test');
  });
});

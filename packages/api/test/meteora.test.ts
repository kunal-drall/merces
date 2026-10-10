import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { SimWallet } from '@merces/simulator';
import { CURVE_NO_CAP, curveBuyerNotice, type UnsignedTx } from '@merces/domain';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * S3 cause codes:
 *  - S3-NC: a curve raise has no wallet cap at any stage (owner; Stage 1 stores 0): every curve read and builder says
 *    so (`walletCap: null`, `noCap: true`, `noCapStatement`), the series read too, and a wallet buys any amount (was:
 *    a bonding-phase cap of 20% of the units offered, refused by the builder and the chain). Every curve response
 *    carries the buyer notice (`CURVE_BUYER_NOTICE` with the curve's figures; was a short notice promising an allowlist
 *    while bonding).
 *  - S3-KP: the admin monitor is a manual trigger of the keepers' lifecycle pass (S3 WP11): its answer lists failures by
 *    code (`errors`), and the last recorded check carries the chain's time.
 *  - S3-CV: Stage 1's curve lifecycle (S3 WP8): the buy builder builds a `curveSwap` against the chain's quote (was
 *    the toy curve's buy against the mock pool), the curve is Open from creation, the monitor completes it and collects its
 *    proceeds (was: the threshold-crossing buy graduated it), the treasury is the partner migration fee, the series
 *    detail's curve is Stage 1's (pool, P0, completion, proceeds). A wallet that is not approved may buy and is warned
 *    it cannot earn (owner question 3's default; was 403).
 */
const NO_CAP = { walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP };
const X = USDC(1000); // Stage 1's worked series (curve_config.json): 100 units, X = 1,000 USDC, P0 = 10 USDC
const NOTICE = curveBuyerNotice({ tradingFeeBps: 100, target: X, migrationFeePercentage: 99 });

describe.skipIf(!dbTestsEnabled())('M6 Meteora support (E14)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('configures a curve-mode series, quotes buys on the chain (USDC and via a USDG swap route), completes it and collects its proceeds', async () => {
    const h = rig.sol;
    const { seriesId } = await h.createCurve();
    await rig.sync();
    // the series read: base lamports (10^6 per whole unit), the curve Open from its creation with P0 fixed (cause S3-CV)
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ raiseStyle: 'curve', unitScale: '1000000', phase: 'Open', issuePrice: '10000000', unitsSold: '100000000' });
    // cause S3-NC: the series read says "no cap" itself; its wallet cap term is Stage 1's 0, never a cap
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ noCap: true, noCapStatement: CURVE_NO_CAP, terms: { walletCapBps: 0, lockupSeconds: 0 } });
    const issuerTok = rig.token({ accountId: 'iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const backerTok = await rig.grant({ accountId: 'b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    // monad has no curve mode
    const monSeries = (await rig.mon.runRaise()).seriesId;
    expect((await rig.get(`/series/${monSeries}/curve`)).statusCode).toBe(422);
    const st0 = await rig.get(`/series/${seriesId}/curve`);
    expect(st0.json()).toMatchObject({ configured: false, ...NO_CAP, notice: NOTICE });
    expect(st0.json().onchain).toMatchObject({ venue: 'simulator-stand-in', migrationQuoteThreshold: X.toString(), quoteReserve: '0', poolComplete: false, settled: false, issuePrice: '10000000', tradingFeeBps: 100 });
    // cause S3-NC: the notice carries the one no-cap statement and the owner's words
    expect(st0.json().notice).toContain(CURVE_NO_CAP);
    expect(st0.json().notice).toMatch(/If the issuer stops paying/);
    expect(st0.json().notice).not.toMatch(/default|only allowlisted wallets can buy/i);
    expect((await rig.post(`/series/${seriesId}/curve/configure`, {}, backerTok)).statusCode).toBe(403);
    const cfg = await rig.post(`/series/${seriesId}/curve/configure`, {}, issuerTok);
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ ...NO_CAP, notice: NOTICE, tokenBadgeRequired: false });
    expect(cfg.json().params.migrationQuoteThreshold).toBe(X.toString());
    // a USDG buyer gets a swap route first, then the curve trade (cause S3-CV: a curveSwap buy, was the toy curve's buy)
    const viaUsdg = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(400).toString(), payIn: 'USDG', slippageBps: 50 }, backerTok);
    expect(viaUsdg.statusCode).toBe(200);
    expect(viaUsdg.json().swap.quote.outAmount).toBe('399800000');
    expect(viaUsdg.json().swap.transactionBase64).toBeTruthy();
    expect(viaUsdg.json().tx.command).toMatchObject({ kind: 'curveSwap', side: 'buy', amountIn: '399800000' });
    expect(viaUsdg.json()).toMatchObject({ ...NO_CAP, notice: NOTICE, earns: true, warning: null });
    // buy with USDC through the builder and relay: the chain's quote (1% fee, P0), the slippage floor, no Merces event
    const buy = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(400).toString(), payIn: 'USDC' }, backerTok);
    expect(buy.statusCode, buy.body).toBe(200);
    expect(buy.json().quote).toEqual({ seriesId, side: 'buy', amountIn: USDC(400).toString(), amountUsed: USDC(400).toString(), amountOut: '39600000', fee: USDC(4).toString(), fillsCurve: false });
    expect(buy.json().minimumAmountOut).toBe(((39_600_000n * 9_950n) / 10_000n).toString());
    const sent = await rig.post('/tx/send', await h.backers[0]!.sign(buy.json().tx as UnsignedTx), backerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    expect(sent.json().events).toEqual([]);
    expect(h.sim.curveUnitsOf(seriesId, h.backers[0]!.address)).toBe(39_600_000n);
    // the monitor (a manual trigger of the keepers' curve.lifecycle pass, cause S3-KP) collects the partner's trading fee
    // (Stage 1 collect_curve_proceeds; the first time at once, then at most weekly); nothing to complete yet
    let mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json()).toEqual({ checked: 1, completed: [], collected: [seriesId], errors: [] });
    const st1 = await rig.get(`/series/${seriesId}/curve`);
    expect(st1.json().onchain).toMatchObject({ progressBps: 3960, poolComplete: false, tradingFeeUncollected: '0', collected: { tradingFee: USDC(3.2).toString(), migrationFee: '0' } });
    expect(st1.json().graduationMonitor).toMatchObject({ chainTime: await h.sim.now(), quoteReserve: USDC(396).toString(), poolComplete: false, settled: false, actions: ['collectCurveProceeds'] });
    // cause S3-NC: the same wallet buys again, any amount, through the builder and on the chain
    const again = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(500).toString(), payIn: 'USDC' }, backerTok);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject(NO_CAP);
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(again.json().tx as UnsignedTx), backerTok)).statusCode).toBe(200);
    expect(h.sim.curveUnitsOf(seriesId, h.backers[0]!.address)).toBe(39_600_000n + 49_500_000n);
    // cause S3-CV: a wallet that is not approved may buy (Stage 1 has no allowlist on the curve), warned it cannot earn;
    // its buy fills the curve (the stand-in's partial fill: it is charged only what the rest of the curve costs)
    const fresh = new SimWallet('solana', 'never-approved');
    await h.sim.fund(fresh.address, 'USDC', USDC(1_000));
    const freshTok = await rig.grant({ accountId: 'b-fresh', wallets: [{ chain: 'solana', address: fresh.address }], roles: ['backer'] });
    const last = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: fresh.address, amountIn: USDC(300).toString(), payIn: 'USDC' }, freshTok);
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json()).toMatchObject({ earns: false, quote: { fillsCurve: true, amountOut: '10900000' } });
    expect(last.json().warning).toMatch(/not approved .* cannot register or stake, so its units earn nothing/);
    expect((await rig.post('/tx/send', await fresh.sign(last.json().tx as UnsignedTx), freshTok)).statusCode).toBe(200);
    // the filled curve takes no more trades: the builder refuses before any swap is built
    const closed = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(10).toString(), payIn: 'USDG' }, backerTok);
    expect(closed.statusCode).toBe(409);
    // the monitor completes the curve and collects its proceeds (permissionless, as the keeper); a second pass has nothing
    mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json()).toEqual({ checked: 1, completed: [seriesId], collected: [seriesId], errors: [] });
    expect((await rig.post('/admin/curves/monitor', {}, adminTok)).json()).toEqual({ checked: 1, completed: [], collected: [], errors: [] });
    await rig.sync();
    const st2 = await rig.get(`/series/${seriesId}/curve`);
    expect(st2.json().onchain).toMatchObject({ poolComplete: true, settled: true, collected: { migrationFee: '990000000', proceeds: '990000000' } });
    // after completion there is still no cap, and the app says so in the same words (cause S3-NC)
    expect(st2.json()).toMatchObject({ ...NO_CAP, notice: NOTICE });
    // and no transfer window ever puts a window cap or allowlist back on curve units
    const win = (await rig.get(`/series/${seriesId}/window`)).json();
    expect(win).toMatchObject({ window: null, walletCapUnits: null, noCap: true, noCapStatement: CURVE_NO_CAP });
    expect(win.rules).toMatch(/trade freely on the DEX pool/);
    expect(win.rules).toContain(CURVE_NO_CAP);
    const now = await h.sim.now();
    await expect(h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper')).rejects.toMatchObject({ code: 'WrongPhase', detail: { stage1: 'NotSealedBid' } });
    // the series detail: settled at the pool's finish time, its curve as indexed, the note with the no-cap statement
    const detail = (await rig.get(`/series/${seriesId}`)).json();
    const finish = (await h.sim.getCurve(seriesId))!.finishCurveTimestamp;
    expect(detail).toMatchObject({ phase: 'Settled', settledAt: finish });
    expect(detail.curve).toMatchObject({ migrationQuoteThreshold: X.toString(), issuePrice: '10000000', unitsSold: '100000000', completed: true, settledAt: finish, proceeds: '990000000', migrationFee: '990000000' });
    expect(detail.curve.note).toContain(CURVE_NO_CAP);
    // activation set the issue price and the cap per unit onchain; the read model serves the same figures (S1 review)
    const onchain = (await h.sim.getSeries(seriesId))!;
    expect(detail).toMatchObject({ issuePrice: onchain.issuePrice, capPerUnit: onchain.capPerUnit });
    const statement = await rig.get(`/admin/accounting/series/${seriesId}`, adminTok);
    expect(statement.json().cap).toMatchObject({ issuePrice: onchain.issuePrice, perUnit: onchain.capPerUnit, remainingPerUnit: onchain.capPerUnit });
    expect(statement.json().fees).toMatchObject({ auction: '0', payout: '0', curveTrading: '8080809', total: '8080809' });
    expect((await rig.post('/admin/curves/monitor', {}, backerTok)).statusCode).toBe(403);
  });

  // cause S3-CV (owner question 3's default): onchain anyone can buy, so the builder warns a wallet that is not approved
  // (`earns: false`) instead of refusing it (was 403); a wallet not linked to the caller is still refused
  it('builds a buy for a wallet that is not approved, warned that it cannot earn; refuses a wallet not linked to the account', async () => {
    const h = rig.sol;
    const { seriesId } = await h.createCurve();
    await rig.sync();
    // eligible through a monad wallet; the solana wallet was never approved
    const fresh = h.sim.address('wallet:never-approved-2');
    await rig.grant({ accountId: 'b-mixed', wallets: [{ chain: 'monad', address: rig.mon.backers[3]!.address }], roles: ['backer'] });
    const mixed = rig.token({ accountId: 'b-mixed', wallets: [{ chain: 'monad', address: rig.mon.backers[3]!.address }, { chain: 'solana', address: fresh }], roles: ['backer'] });
    const r = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: fresh, amountIn: USDC(100).toString(), payIn: 'USDC' }, mixed);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ earns: false, ...NO_CAP, notice: NOTICE });
    expect(r.json().tx.command).toMatchObject({ kind: 'curveSwap', side: 'buy' });
    // a wallet removed from the allowlist is warned too; restoring it clears the warning
    const w = h.backers[3]!;
    const tok = await rig.grant({ accountId: 'b-revoked', wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'] });
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: false }, 'allowlistManager');
    expect((await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: w.address, amountIn: USDC(100).toString(), payIn: 'USDC' }, tok)).json()).toMatchObject({ earns: false });
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    expect((await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: w.address, amountIn: USDC(100).toString(), payIn: 'USDC' }, tok)).json()).toMatchObject({ earns: true, warning: null });
    // a wallet the caller has not linked is refused
    expect((await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[4]!.address, amountIn: USDC(100).toString(), payIn: 'USDC' }, tok)).statusCode).toBe(403);
  });
});

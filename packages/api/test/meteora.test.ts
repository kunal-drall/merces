import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { defaultTerms } from '@merces/simulator';
import { defaultMeteoraProviders } from '@merces/services';
import { CURVE_NO_CAP, type UnsignedTx } from '@merces/domain';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * S3 cause codes:
 *  - S3-NC: a curve raise has no wallet cap at any stage (owner; Stage 1 stores 0): every curve read and builder says
 *    so (`walletCap: null`, `noCap: true`, `noCapStatement`), the series read too, and a wallet buys any amount (was:
 *    a bonding-phase cap of 20% of the units offered, refused by the builder and the chain).
 */
const NO_CAP = { walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP };

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
    // S3: the series read derives Stage 1's unit scale from the raise style: a curve series counts base lamports, 10^6
    // per whole unit (the simulator's curve keeps them from S3 WP8)
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ raiseStyle: 'curve', unitScale: '1000000' });
    // cause S3-NC: the series read says "no cap" itself; its wallet cap term is Stage 1's 0, never a cap
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ noCap: true, noCapStatement: CURVE_NO_CAP, terms: { walletCapBps: 0, lockupSeconds: 0 } });
    const issuerTok = rig.token({ accountId: 'iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const backerTok = await rig.grant({ accountId: 'b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
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
    expect(cfg.json()).toMatchObject(NO_CAP);
    expect(cfg.json().tokenBadgeRequired).toBe(false);
    expect(cfg.json().params.migrationQuoteThreshold).toBe(USDC(2000).toString());
    // a USDG buyer gets a swap route first, then the curve buy
    const viaUsdg = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(1000).toString(), payIn: 'USDG', slippageBps: 50 }, backerTok);
    expect(viaUsdg.statusCode).toBe(200);
    expect(viaUsdg.json().swap.quote.outAmount).toBe('999500000');
    expect(viaUsdg.json().swap.transactionBase64).toBeTruthy();
    expect(viaUsdg.json().tx.command.kind).toBe('buyCurve');
    // cause S3-NC: no cap is shown with the notice, which says it in the one statement (was: a 200-unit bonding cap)
    expect(st0.json()).toMatchObject(NO_CAP);
    expect(viaUsdg.json()).toMatchObject(NO_CAP);
    expect(st0.json().notice).toContain(CURVE_NO_CAP);
    expect(st0.json().notice).toMatch(/After graduation the units trade freely/);
    expect(st0.json().notice).not.toMatch(/wallet cap shown|at most/);
    // buy with USDC through the builder and relay; mirror into the mock pool
    const buy = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(900).toString(), payIn: 'USDC' }, backerTok);
    expect(buy.statusCode, buy.body).toBe(200);
    expect(BigInt(buy.json().minUnitsOut)).toBeGreaterThan(0n);
    const sent = await rig.post('/tx/send', await h.backers[0]!.sign(buy.json().tx as UnsignedTx), backerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const minted = sent.json().events.find((e: { type: string }) => e.type === 'UnitsMinted');
    expect(BigInt(minted.payload.units)).toBeGreaterThan(0n);
    defaultMeteoraProviders.meteora.applyBuy(cfg.json().pool, USDC(900), BigInt(minted.payload.units));
    let mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json()).toEqual({ checked: 1, graduated: [] });
    const st1 = await rig.get(`/series/${seriesId}/curve`);
    expect(st1.json().onchain.graduated).toBe(false);
    expect(st1.json().pool.progressBps).toBe(4500);
    // cause S3-NC: the same wallet buys again, past what the old 200-unit bonding cap allowed, through the builder and
    // on the chain (was: 422 from the builder, WalletCap from the chain)
    const again = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(300).toString(), payIn: 'USDC' }, backerTok);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject(NO_CAP);
    const sentAgain = await rig.post('/tx/send', await h.backers[0]!.sign(again.json().tx as UnsignedTx), backerTok);
    expect(sentAgain.statusCode, sentAgain.body).toBe(200);
    const mintedAgain = BigInt(sentAgain.json().events.find((e: { type: string }) => e.type === 'UnitsMinted').payload.units);
    expect(BigInt(minted.payload.units) + mintedAgain).toBeGreaterThan(200n);
    defaultMeteoraProviders.meteora.applyBuy(cfg.json().pool, USDC(300), mintedAgain);
    // other wallets buy too; the third wallet's buy crosses the threshold and the curve graduates
    const b1Tok = await rig.grant({ accountId: 'b1', wallets: [{ chain: 'solana', address: h.backers[1]!.address }], roles: ['backer'] });
    const buy2 = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[1]!.address, amountIn: USDC(600).toString(), payIn: 'USDC' }, b1Tok);
    expect(buy2.statusCode, buy2.body).toBe(200);
    const sent2 = await rig.post('/tx/send', await h.backers[1]!.sign(buy2.json().tx as UnsignedTx), b1Tok);
    expect(sent2.statusCode, sent2.body).toBe(200);
    expect(sent2.json().events.map((e: { type: string }) => e.type)).not.toContain('CurveGraduated');
    // keep the mock pool in step with the simulator so its quote (and minUnitsOut) matches the chain
    defaultMeteoraProviders.meteora.applyBuy(cfg.json().pool, USDC(600), BigInt(sent2.json().events.find((e: { type: string }) => e.type === 'UnitsMinted').payload.units));
    const b2Tok = await rig.grant({ accountId: 'b2', wallets: [{ chain: 'solana', address: h.backers[2]!.address }], roles: ['backer'] });
    const buy3 = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[2]!.address, amountIn: USDC(300).toString(), payIn: 'USDC' }, b2Tok);
    expect(buy3.statusCode, buy3.body).toBe(200);
    const sent3 = await rig.post('/tx/send', await h.backers[2]!.sign(buy3.json().tx as UnsignedTx), b2Tok);
    expect(sent3.statusCode, sent3.body).toBe(200);
    expect(sent3.json().events.map((e: { type: string }) => e.type)).toContain('CurveGraduated');
    mon = await rig.post('/admin/curves/monitor', {}, adminTok);
    expect(mon.json().graduated).toEqual([]);
    await rig.sync();
    const st2 = await rig.get(`/series/${seriesId}/curve`);
    expect(st2.json().onchain.graduated).toBe(true);
    // after graduation there is still no cap, and the app says so in the same words (cause S3-NC)
    expect(st2.json()).toMatchObject(NO_CAP);
    // and no transfer window ever puts a window cap or allowlist back on curve units
    const win = (await rig.get(`/series/${seriesId}/window`)).json();
    expect(win).toMatchObject({ window: null, walletCapUnits: null, noCap: true, noCapStatement: CURVE_NO_CAP });
    expect(win.rules).toMatch(/trade freely on the DEX pool/);
    expect(win.rules).toContain(CURVE_NO_CAP);
    // the public series detail's curve note says it too
    expect((await rig.get(`/series/${seriesId}`)).json().curve.note).toContain(CURVE_NO_CAP);
    const now = await h.sim.now();
    await expect(h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper')).rejects.toMatchObject({ code: 'WrongPhase' });
    expect((await rig.get(`/series/${seriesId}`)).json().phase).toBe('Settled');
    expect((await rig.get(`/series/${seriesId}`)).json().curve.graduated).toBe(true);
    // graduation set the issue price and the cap per unit onchain; the read model serves the same figures (S1 review)
    const onchain = (await h.sim.getSeries(seriesId))!;
    expect(onchain.issuePrice).not.toBeNull();
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ issuePrice: onchain.issuePrice, capPerUnit: onchain.capPerUnit });
    const statement = await rig.get(`/admin/accounting/series/${seriesId}`, adminTok);
    expect(statement.json().cap).toMatchObject({ issuePrice: onchain.issuePrice, perUnit: onchain.capPerUnit, remainingPerUnit: onchain.capPerUnit });
    expect((await rig.post('/admin/curves/monitor', {}, backerTok)).statusCode).toBe(403);
  });

  it('refuses to build a curve buy for a wallet that is not allowlisted on that chain, even when the account is eligible elsewhere', async () => {
    const h = rig.sol;
    await h.exec(h.issuer, { kind: 'registerIssuer' }).catch(() => undefined);
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await rig.sync();
    // eligible through a monad wallet; the solana wallet was never approved
    const fresh = h.sim.address('wallet:never-approved');
    await rig.grant({ accountId: 'b-mixed', wallets: [{ chain: 'monad', address: rig.mon.backers[3]!.address }], roles: ['backer'] });
    const mixed = rig.token({ accountId: 'b-mixed', wallets: [{ chain: 'monad', address: rig.mon.backers[3]!.address }, { chain: 'solana', address: fresh }], roles: ['backer'] });
    const r = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: fresh, amountIn: USDC(100).toString(), payIn: 'USDC' }, mixed);
    expect(r.statusCode).toBe(403);
    expect(r.json().tx).toBeUndefined();
    // a wallet removed from the allowlist is refused too; restoring it lets the build through
    const w = h.backers[3]!;
    const tok = await rig.grant({ accountId: 'b-revoked', wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'] });
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: false }, 'allowlistManager');
    expect((await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: w.address, amountIn: USDC(100).toString(), payIn: 'USDC' }, tok)).statusCode).toBe(403);
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    expect((await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: w.address, amountIn: USDC(100).toString(), payIn: 'USDC' }, tok)).statusCode).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { orderCommitment } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { AuctionService, IdentityService } from '@merces/services';
import { SimWallet, defaultTerms } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Races and past-holder edges: concurrent decisions, settlements that lose a race, sellers who still have payouts. */
describe.skipIf(!dbTestsEnabled())('concurrency and past-holder edges', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('a holder who sold every unit in a window before claiming can still see and claim the payout that accrued', async () => {
    const h = rig.sol;
    const raise = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const seriesId = raise.seriesId;
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(100_000));
    const seller = h.backers[0]!;
    const units = BigInt((await h.sim.getPosition(seriesId, seller.address))!.units);
    const now = await h.sim.now();
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const buyer = h.sim.address('wallet:past-holder-buyer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer, 'USDC', USDC(10_000));
    const price = USDC(1);
    const ss = '0x' + 'cc'.repeat(32);
    const bs = '0x' + 'dd'.repeat(32);
    const asBuyer = async (cmd: Parameters<typeof h.sim.build>[0]) => h.sim.send({ tx: await h.sim.build(cmd, buyer), signatures: { [buyer]: `sim:${buyer}` } });
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: orderCommitment({ seriesId, windowId: 0, wallet: seller.address, side: 'sell', pricePerUnit: price, quantity: units, salt: ss }), deposit: '0', units: units.toString() });
    await asBuyer({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: orderCommitment({ seriesId, windowId: 0, wallet: buyer, side: 'buy', pricePerUnit: price, quantity: units, salt: bs }), deposit: (price * units).toString(), units: '0' });
    await h.sim.setTime(now + 100);
    await h.exec(seller, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: price.toString(), quantity: units.toString(), salt: ss });
    await asBuyer({ kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: price.toString(), quantity: units.toString(), salt: bs });
    await h.sim.setTime(now + 200);
    await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    await rig.sync();
    expect((await h.sim.getPosition(seriesId, seller.address))!.units).toBe('0');
    const tok = rig.token({ accountId: 'past-holder', wallets: [{ chain: 'solana', address: seller.address }], roles: ['backer'] });
    expect((await rig.get(`/series/${seriesId}/payouts`, tok)).statusCode).toBe(200);
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: seller.address }, tok);
    expect(claim.statusCode, claim.body).toBe(200);
  });

  it('two admins deciding at once: one decision wins, and the allowlist always matches it', async () => {
    const w = new SimWallet('solana', 'race-backer');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'acct-race', wallets: [{ chain: 'solana', address: w.address, family: 'solana' }], roles: ['backer'], eligible: false });
    const tok = rig.token({ accountId: 'acct-race', wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'], eligible: false });
    const app = (await rig.post('/applications', { kind: 'backer', chain: 'solana', wallet: w.address, country: 'GB' }, tok)).json();
    await rig.post(`/applications/${app.applicationId}/identity/start`, {}, tok);
    await rig.post(`/applications/${app.applicationId}/submit`, {}, tok);
    const sim = rig.sol.sim;
    const orig = sim.submit.bind(sim);
    sim.submit = async (...args: Parameters<typeof orig>) => {
      await new Promise((r) => setTimeout(r, 300)); // a slow allowlist manager RPC
      return orig(...args);
    };
    const [ap, rj] = await Promise.all([
      rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, rig.token({ accountId: 'admin-a', roles: ['admin'], wallets: [] })),
      new Promise((r) => setTimeout(r, 50)).then(() => rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'rejected', reasonCode: 'no' }, rig.token({ accountId: 'admin-b', roles: ['admin'], wallets: [] }))),
    ]);
    sim.submit = orig;
    expect([ap.statusCode, rj.statusCode].sort()).toEqual([200, 409]);
    const state = (await rig.get(`/applications/${app.applicationId}`, tok)).json().state;
    const eligible = (await rig.t.pool.query('select 1 from eligibility where wallet = $1 and revoked_at is null', [w.address])).rowCount === 1;
    expect(await sim.isAllowlisted(w.address)).toBe(state === 'approved');
    expect(eligible).toBe(state === 'approved');
  });

  it('a settlement that loses the race to someone else is not a keeper failure', async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise();
    const settled = (await h.sim.getSeries(seriesId))!;
    // the keeper listed the series while it was still Open; someone settled it before the keeper's submit
    const realList = h.sim.listSeries.bind(h.sim);
    h.sim.listSeries = async () => (await realList()).map((x) => (x.seriesId === seriesId ? { ...settled, phase: 'Open' as const } : x));
    try {
      const r = await new AuctionService(rig.ctx).settleDue();
      expect(r).toEqual({ settled: [], failed: [] });
    } finally {
      h.sim.listSeries = realList;
    }
  });

  it('a cancelled curve raise refuses buys, in the builder and onchain', async () => {
    const h = rig.sol;
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await h.exec(h.issuer, { kind: 'cancelRaise', seriesId });
    const tok = await rig.grant({ accountId: 'curve-cancel-b1', wallets: [{ chain: 'solana', address: h.backers[1]!.address }], roles: ['backer'] });
    const buy = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[1]!.address, amountIn: USDC(10).toString(), payIn: 'USDG' }, tok);
    expect(buy.statusCode).toBe(409);
    await expect(h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(10).toString(), minUnitsOut: '0' })).rejects.toMatchObject({ code: 'WrongPhase' });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { orderCommitment, type PermissionlessCommand } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { AuctionService, IdentityService } from '@merces/services';
import { SimWallet, defaultTerms } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes.
 */

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/*
 * S2 cause codes:
 *  - S2-MS: Stage 1's multi-step settlement (begin, tally pages, finalize, process, deliver), every step permissionless.
 */

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
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: orderCommitment({ wallet: seller.address, pricePerUnit: price, quantity: units, salt: ss }), deposit: '0', units: units.toString() });
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    await asBuyer({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: orderCommitment({ wallet: buyer, pricePerUnit: price, quantity: units, salt: bs }), deposit: (price * units).toString(), units: '0' });
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

  // cause S2-MS: Stage 1 settles in steps anyone may send; the race is now for a step (was: the one-step settlement), and
  // the keepers settle and deliver in separate passes (`advanceSettlements`, then `deliverDue`)
  it('a settlement step or a delivery that loses the race to someone else is not a keeper failure: the keeper re-plans and finishes', async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise({ settle: 'none' });
    // another sender's beginSettlement (the same honest proposal) lands between the keeper's read and its submit; later a
    // bidder's own delivery does the same to the keeper's deliverBid
    const realSubmit = h.sim.submit.bind(h.sim);
    let raced = false;
    let racedDelivery: string | null = null;
    h.sim.submit = async (...args: Parameters<typeof realSubmit>) => {
      const cmd = args[0];
      if (!raced && cmd.kind === 'beginSettlement') {
        raced = true;
        await h.exec(h.backers[4]!, cmd as PermissionlessCommand);
      }
      if (racedDelivery === null && cmd.kind === 'deliverBid') {
        racedDelivery = cmd.bidder;
        await h.exec(h.backers.find((w) => w.address === cmd.bidder)!, cmd as PermissionlessCommand);
      }
      return realSubmit(...args);
    };
    try {
      const svc = new AuctionService(rig.ctx);
      const r = await svc.advanceSettlements({ deliver: false });
      expect(raced).toBe(true);
      expect(r.failed).toEqual([]);
      expect(r.stuck).toEqual([]);
      // the keeper's own beginSettlement was refused (TallyInProgress) and is not among its steps
      expect(r.advanced.find((a) => a.seriesId === seriesId)).toEqual({ seriesId, steps: ['tallyBids', 'finalizeSettlement', ...Array(5).fill('processBid')], stage: 'delivering' });
      // the delivery pass: the bid its bidder delivered first (AlreadyDelivered) is neither a failure nor a delivery
      const d = await svc.deliverDue();
      expect(racedDelivery).not.toBeNull();
      expect(d.failed).toEqual([]);
      expect(d.errors).toEqual([]);
      expect(d.delivered.filter((x) => x.seriesId === seriesId).map((x) => x.bidder).sort()).toEqual(h.backers.slice(0, 5).map((w) => w.address).filter((a) => a !== racedDelivery).sort());
    } finally {
      h.sim.submit = realSubmit;
    }
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settled', round: 1, mintFinalized: true, bidsProcessed: 5 });
    expect((await h.sim.listBids(seriesId)).every((b) => b.delivered)).toBe(true);
    expect((await rig.t.pool.query('select 1 from auction_deliveries where series_id = $1', [seriesId])).rowCount).toBe(0);
  });

  // cause S3-CV: a curve raise cannot be cancelled (NotSealedBid); a filled curve refuses buys, in the builder (before
  // any USDG swap is built) and onchain (was: a cancelled curve)
  it('a filled curve refuses buys, in the builder and onchain', async () => {
    const h = rig.sol;
    const { seriesId } = await h.createCurve();
    await expect(h.exec(h.issuer, { kind: 'cancelRaise', seriesId })).rejects.toMatchObject({ code: 'WrongPhase', detail: { stage1: 'NotSealedBid' } });
    for (const [i, amount] of [400, 350, 300].entries()) await h.curveBuy(seriesId, h.backers[i]!, USDC(amount));
    const tok = await rig.grant({ accountId: 'curve-cancel-b1', wallets: [{ chain: 'solana', address: h.backers[1]!.address }], roles: ['backer'] });
    const buy = await rig.post(`/series/${seriesId}/curve/build-swap`, { wallet: h.backers[1]!.address, side: 'buy', amountIn: USDC(10).toString(), payIn: 'USDG' }, tok);
    expect(buy.statusCode).toBe(409);
    await expect(h.curveBuy(seriesId, h.backers[1]!, USDC(10))).rejects.toMatchObject({ code: 'WrongPhase' });
  });
});

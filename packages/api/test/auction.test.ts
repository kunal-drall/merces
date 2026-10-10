import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { bidCommitment, type UnsignedTx } from '@merces/domain';
import { AuctionService, ZERO_BID_GRACE_SECONDS } from '@merces/services';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/*
 * S2 cause codes on the pins that moved:
 *  - S2-AD: commit and reveal durations are series terms (Stage 1's minimum is one hour each, where these raises opened
 *    1,000-second phases); `openRaise` derives the phase ends from them;
 *  - S2-DA: a bidder removed from the allowlist after committing stays valid, is settled and is delivered (A-REV-2
 *    withdrawn);
 *  - S2-FP: a failed raise keeps its price and would-be results, with Stage 1's reason (NoValidBids / MinRaise);
 *  - S2-MS: Stage 1's multi-step settlement, driven by the keepers' `advanceSettlements` (was the one-step
 *    `settleDue`);
 *  - S2-PR: refunds and units are pushed by `deliverBid` (the keepers deliver every bid; `claimRefund` retired).
 */
const HOUR = 3_600;
const phases = { commitDurationSeconds: HOUR, revealDurationSeconds: HOUR }; // cause S2-AD

describe.skipIf(!dbTestsEnabled())('M4 auction service (E6)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('prechecks, builds commit/reveal/refund, keeps only encrypted backups, previews clearing and settles by keeper', async () => {
    const h = rig.harness('monad');
    const { terms } = (await import('@merces/simulator')).defaultTerms(h.sim, { unitsOffered: '1000', walletCapBps: 1000, ...phases });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD
    await rig.sync();
    const backer = h.backers[0]!;
    const tok = await rig.grant({ accountId: 'b0', wallets: [{ chain: 'monad', address: backer.address }], roles: ['backer'], eligible: true });
    const ineligible = rig.token({ accountId: 'b9', wallets: [{ chain: 'monad', address: backer.address }], roles: ['backer'], eligible: false });
    expect((await rig.post(`/series/${seriesId}/bids/precheck`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100' }, ineligible)).statusCode).toBe(403);
    // over the cap and below reserve
    const bad = await rig.post(`/series/${seriesId}/bids/precheck`, { bidder: backer.address, pricePerUnit: USDC(7).toString(), quantity: '150' }, tok);
    expect(bad.json().ok).toBe(false);
    expect(bad.json().issues.map((i: { code: string }) => i.code).sort()).toEqual(['reserve', 'wallet-cap']);
    const ok = await rig.post(`/series/${seriesId}/bids/precheck`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100' }, tok);
    expect(ok.json()).toMatchObject({ ok: true, deposit: USDC(1010).toString(), walletCapUnits: '100', fee: USDC(10).toString() });
    // the client computes the commitment and keeps an encrypted backup
    const salt = '0x' + 'ee'.repeat(32);
    const commitment = bidCommitment({ seriesId, bidder: backer.address, pricePerUnit: USDC(10), quantity: 100n, salt });
    expect((await rig.post(`/series/${seriesId}/bids/commitment`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100', salt }, tok)).json().commitment).toBe(commitment);
    expect((await rig.put(`/series/${seriesId}/bids/backup`, { bidder: backer.address, ciphertext: JSON.stringify({ pricePerUnit: '10', quantity: '100', salt }) }, tok)).statusCode).toBe(400);
    expect((await rig.put(`/series/${seriesId}/bids/backup`, { bidder: backer.address, ciphertext: 'age-encryption.org/v1 QUJDREVG...', keyHint: 'ledger-1' }, tok)).statusCode).toBe(200);
    const backup = await rig.get(`/series/${seriesId}/bids/backup/${backer.address}`, tok);
    expect(backup.json().keyHint).toBe('ledger-1');
    expect((await rig.get(`/series/${seriesId}/bids/backup/${backer.address}`, rig.token({ accountId: 'other', wallets: [] }))).statusCode).toBe(403);
    // commit via builder + relay
    const commit = await rig.post(`/series/${seriesId}/bids/build-commit`, { bidder: backer.address, commitment, deposit: USDC(1010).toString() }, tok);
    expect((await rig.post('/tx/send', await backer.sign(commit.json().tx as UnsignedTx), tok)).statusCode).toBe(200);
    // a bid alone never makes the bidder a holder: the holder list and payment views stay closed
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/holders`, tok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/reports`, tok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/bids/precheck`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100' }, tok)).json().issues.map((i: { code: string }) => i.code)).toEqual(['duplicate']);
    // a second bidder so the minimum raise is met
    const b2 = h.backers[1]!;
    const tok2 = await rig.grant({ accountId: 'b1', wallets: [{ chain: 'monad', address: b2.address }], roles: ['backer'], eligible: true });
    const salt2 = '0x' + 'ef'.repeat(32);
    const c2 = bidCommitment({ seriesId, bidder: b2.address, pricePerUnit: USDC(45), quantity: 100n, salt: salt2 });
    await h.exec(b2, { kind: 'commitBid', seriesId, commitment: c2, deposit: USDC(4545).toString() });
    // reveal phase
    await h.sim.setTime(now + HOUR); // cause S2-AD (was now + 1000)
    expect((await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: backer.address, pricePerUnit: USDC(11).toString(), quantity: '100', salt }, tok)).statusCode).toBe(422);
    const reveal = await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100', salt }, tok);
    expect((await rig.post('/tx/send', await backer.sign(reveal.json().tx as UnsignedTx), tok)).statusCode).toBe(200);
    const reveal2 = await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: b2.address, pricePerUnit: USDC(45).toString(), quantity: '100', salt: salt2 }, tok2);
    await rig.post('/tx/send', await b2.sign(reveal2.json().tx as UnsignedTx), tok2);
    // preview: 200 units at the lowest winning price 10 → proceeds 2000 < min raise 4000 → projected failure, settlement not yet due
    const pv = await rig.get(`/series/${seriesId}/auction/preview`);
    expect(pv.json()).toMatchObject({ settleDue: false, stage: 'reveal' });
    // cause S2-FP: Stage 1's reason, the would-be price and units, and each bid's processing (a failed raise refunds all)
    expect(pv.json().projected).toMatchObject({ success: false, reason: 'MinRaise', clearingPrice: USDC(10).toString(), unitsSold: '200', proceeds: USDC(2000).toString(), qAboveClaim: '100', qAtClaim: '100', R: '0' });
    expect(pv.json().projected.allocations).toEqual([
      { bidder: backer.address, units: '0', cost: '0', fee: '0', refund: USDC(1010).toString() },
      { bidder: b2.address, units: '0', cost: '0', fee: '0', refund: USDC(4545).toString() },
    ]);
    // the build path refuses a delivery before the bid is processed
    expect((await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: backer.address }, tok)).statusCode).toBe(409);
    // cause S2-MS: the keepers settle in Stage 1's steps once the reveal phase is over; a pass with nothing to do is harmless
    const svc = new AuctionService(rig.ctx as never);
    expect(await svc.advanceSettlements({ deliver: true })).toEqual({ advanced: [], stuck: [], failed: [] });
    await h.sim.setTime(now + 2 * HOUR); // cause S2-AD (was now + 2000)
    expect((await rig.get(`/series/${seriesId}/auction/preview`)).json()).toMatchObject({ settleDue: true, stage: 'awaiting-proposal' });
    const before = BigInt(await h.sim.getBalance(backer.address, 'USDC'));
    const first = await svc.advanceSettlements({ deliver: true });
    expect(first).toEqual({ advanced: [{ seriesId, steps: ['beginSettlement', 'tallyBids', 'finalizeSettlement', 'processBid', 'processBid', 'deliverBid', 'deliverBid'], stage: 'failed-complete' }], stuck: [], failed: [] });
    expect(await svc.advanceSettlements({ deliver: true })).toEqual({ advanced: [], stuck: [], failed: [] });
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Failed');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ failureReason: 'MinRaise', clearingPrice: USDC(10).toString(), unitsSold: '200', mintFinalized: true });
    // cause S2-PR: the keeper delivered the deposit in full; nothing is left for the bidder's own delivery (409)
    expect(BigInt(await h.sim.getBalance(backer.address, 'USDC')) - before).toBe(USDC(1010));
    expect(await h.sim.getBid(seriesId, backer.address)).toMatchObject({ processed: true, delivered: true, pendingRefund: '0' });
    expect((await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: backer.address }, tok)).statusCode).toBe(409);
    // the notice comes from the indexer, in the transaction that projects the finalized AuctionFailed event
    await rig.sync();
    const notified = await rig.t.pool.query("select payload->>'kind' as kind from outbox where payload->>'seriesId' = $1", [seriesId]);
    expect(notified.rows.map((r) => r.kind)).toContain('auction.failed');
  });

  // cause S2-MS: Stage 1 lets the issuer cancel an Open raise while no bid exists, with no time limit (SIM:578-585), so
  // the keepers leave a raise that drew no bid alone for 24 hours past its reveal end (A-AUC-12); anyone may settle it
  // earlier with a step of their own
  it('the keepers leave a raise with no bid to its issuer for 24 hours after the reveal end, then fail it (NoValidBids)', async () => {
    const h = rig.harness('solana');
    const svc = new AuctionService(rig.ctx as never);
    const mine = (r: Awaited<ReturnType<AuctionService['advanceSettlements']>>, ids: string[]) => ({ ...r, advanced: r.advanced.filter((x) => ids.includes(x.seriesId)) });
    const cancelled = (await h.runRaise({ bids: [], settle: 'none', terms: phases })).seriesId;
    const left = (await h.runRaise({ bids: [], settle: 'none', terms: phases })).seriesId;
    const ids = [cancelled, left];
    const { revealEndsAt } = (await h.sim.getAuction(left))!;
    expect((await h.sim.now()) >= revealEndsAt!).toBe(true);
    expect(mine(await svc.advanceSettlements({ deliver: true }), ids)).toEqual({ advanced: [], stuck: [], failed: [] });
    // the issuer may still cancel
    expect((await h.exec(h.issuer, { kind: 'cancelRaise', seriesId: cancelled })).events.map((e) => e.type)).toEqual(['RaiseCancelled']);
    await h.sim.setTime(revealEndsAt! + ZERO_BID_GRACE_SECONDS - 1);
    expect(mine(await svc.advanceSettlements({ deliver: true }), ids)).toEqual({ advanced: [], stuck: [], failed: [] });
    await h.sim.setTime(revealEndsAt! + ZERO_BID_GRACE_SECONDS);
    expect(mine(await svc.advanceSettlements({ deliver: true }), ids)).toEqual({ advanced: [{ seriesId: left, steps: ['beginSettlement', 'finalizeSettlement'], stage: 'failed-complete' }], stuck: [], failed: [] });
    expect(await h.sim.getAuction(left)).toMatchObject({ raiseState: 'Failed', failureReason: 'NoValidBids', clearingPrice: null, mintFinalized: true });
    expect((await h.sim.getSeries(cancelled))!.phase).toBe('Cancelled');
  });

  // S2 amendment L7: a keeper failure carries a code, never an adapter message (Stage 1 messages can embed values)
  it('a settlement failure is reported by series and code only', async () => {
    const h = rig.harness('monad');
    const { seriesId } = await h.runRaise({ settle: 'none', terms: phases });
    const realSubmit = h.sim.submit.bind(h.sim);
    h.sim.submit = async () => {
      throw new Error('upstream refused a fee of 987654321');
    };
    try {
      const r = await new AuctionService(rig.ctx as never).advanceSettlements({ deliver: false });
      expect(r.failed).toEqual([{ target: seriesId, error: 'Error' }]);
      expect(JSON.stringify(r)).not.toContain('987654321');
    } finally {
      h.sim.submit = realSubmit;
    }
    await h.settle(seriesId, 'deliver');
  });

  // cause S2-DA: Stage 1 checks the allowlist at commit only: a bidder removed afterwards stays in the settlement (and so
  // in the preview) and is delivered (was: both left it out, A-REV-2 withdrawn)
  it('the clearing preview keeps a bidder removed from the allowlist, exactly as settlement does, and the bidder is delivered', async () => {
    const h = rig.harness('monad');
    const { terms } = (await import('@merces/simulator')).defaultTerms(h.sim, { unitsOffered: '1000', walletCapBps: 1000, ...phases });
    await h.exec(h.issuer, { kind: 'registerIssuer' }).catch(() => undefined);
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD
    const [lo, hi] = [h.backers[2]!, h.backers[3]!];
    const bids = [{ w: lo, price: USDC(10), salt: '0x' + 'a1'.repeat(32) }, { w: hi, price: USDC(45), salt: '0x' + 'a2'.repeat(32) }];
    for (const b of bids) {
      const commitment = bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: 100n, salt: b.salt });
      await h.exec(b.w, { kind: 'commitBid', seriesId, commitment, deposit: ((b.price * 101n) / 100n * 100n).toString() });
    }
    await h.sim.setTime(now + HOUR); // cause S2-AD (was now + 1000)
    for (const b of bids) await h.exec(b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: '100', salt: b.salt });
    // with both bids the raise clears at 10 for 200 units (2000 < 4000 minimum): projected failure
    expect((await rig.get(`/series/${seriesId}/auction/preview`)).json().projected).toMatchObject({ success: false, unitsSold: '200' });
    // the low bidder leaves the allowlist: its bid still counts, so the projection does not change
    await h.sim.submit({ kind: 'setAllowlist', wallet: lo.address, allowed: false }, 'allowlistManager');
    await h.sim.setTime(now + 2 * HOUR); // cause S2-AD (was now + 2000)
    const pv = (await rig.get(`/series/${seriesId}/auction/preview`)).json();
    expect(pv.projected).toMatchObject({ success: false, clearingPrice: USDC(10).toString(), unitsSold: '200' });
    await h.settle(seriesId, 'process'); // cause S2-MS (was the one-step settleAuction)
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Failed');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ failureReason: 'MinRaise', clearingPrice: pv.projected.clearingPrice, unitsSold: pv.projected.unitsSold });
    // the removed bidder is delivered its deposit in full (any wallet may deliver it)
    const before = BigInt(await h.sim.getBalance(lo.address, 'USDC'));
    await h.exec(hi, { kind: 'deliverBid', seriesId, bidder: lo.address });
    expect(BigInt(await h.sim.getBalance(lo.address, 'USDC')) - before).toBe(USDC(1010));
    expect(await h.sim.isAllowlisted(lo.address)).toBe(false);
    await h.sim.submit({ kind: 'setAllowlist', wallet: lo.address, allowed: true }, 'allowlistManager');
  });
});

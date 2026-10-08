import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { bidCommitment, type UnsignedTx } from '@merces/domain';
import { AuctionService } from '@merces/services';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

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
    const { terms } = (await import('@merces/simulator')).defaultTerms(h.sim, { unitsOffered: '1000', walletCapBps: 1000 });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 1000, revealEndsAt: now + 2000 });
    await rig.sync();
    const backer = h.backers[0]!;
    const tok = rig.token({ accountId: 'b0', wallets: [{ chain: 'monad', address: backer.address }], roles: ['backer'], eligible: true });
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
    expect((await rig.post(`/series/${seriesId}/bids/precheck`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100' }, tok)).json().issues.map((i: { code: string }) => i.code)).toEqual(['duplicate']);
    // a second bidder so the minimum raise is met
    const b2 = h.backers[1]!;
    const tok2 = rig.token({ accountId: 'b1', wallets: [{ chain: 'monad', address: b2.address }], roles: ['backer'], eligible: true });
    const salt2 = '0x' + 'ef'.repeat(32);
    const c2 = bidCommitment({ seriesId, bidder: b2.address, pricePerUnit: USDC(45), quantity: 100n, salt: salt2 });
    await h.exec(b2, { kind: 'commitBid', seriesId, commitment: c2, deposit: USDC(4545).toString() });
    // reveal phase
    await h.sim.setTime(now + 1000);
    expect((await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: backer.address, pricePerUnit: USDC(11).toString(), quantity: '100', salt }, tok)).statusCode).toBe(422);
    const reveal = await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: backer.address, pricePerUnit: USDC(10).toString(), quantity: '100', salt }, tok);
    expect((await rig.post('/tx/send', await backer.sign(reveal.json().tx as UnsignedTx), tok)).statusCode).toBe(200);
    const reveal2 = await rig.post(`/series/${seriesId}/bids/build-reveal`, { bidder: b2.address, pricePerUnit: USDC(45).toString(), quantity: '100', salt: salt2 }, tok2);
    await rig.post('/tx/send', await b2.sign(reveal2.json().tx as UnsignedTx), tok2);
    // preview: 200 units at the lowest winning price 10 → proceeds 2000 < min raise 4000 → projected failure, settlement not yet due
    const pv = await rig.get(`/series/${seriesId}/auction/preview`);
    expect(pv.json().settleDue).toBe(false);
    expect(pv.json().projected).toMatchObject({ success: false, reason: 'below-minimum-raise', clearingPrice: USDC(10).toString(), unitsSold: '200' });
    // keeper settles when due; running it twice is harmless
    const svc = new AuctionService(rig.ctx as never);
    expect((await svc.settleDue()).settled).toEqual([]);
    await h.sim.setTime(now + 2000);
    expect((await rig.get(`/series/${seriesId}/auction/preview`)).json().settleDue).toBe(true);
    const first = await svc.settleDue();
    expect(first.settled).toEqual([seriesId]);
    expect((await svc.settleDue()).settled).toEqual([]);
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Failed');
    // refunds: builder reports the full deposit and the relay returns it
    const refund = await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: backer.address }, tok);
    expect(refund.json().refundable).toBe(USDC(1010).toString());
    expect((await rig.post('/tx/send', await backer.sign(refund.json().tx as UnsignedTx), tok)).json().events[0].type).toBe('BidRefunded');
    expect((await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: backer.address }, tok)).statusCode).toBe(409);
    const notified = await rig.t.pool.query("select payload->>'kind' as kind from outbox where payload->>'seriesId' = $1", [seriesId]);
    expect(notified.rows.map((r) => r.kind)).toContain('auction.failed');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { ChainError, bidCommitment, type SignedTx, type UnsignedTx } from '@merces/domain';
import { defaultTerms, type SimHarness, type SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * S2 WP7: the chain-neutral HTTP surface of Stage 1's sealed-bid raise and its multi-step settlement. New tests (no pin
 * moved here): the issuer's open and cancel builders, the delivery builder (`build-deliver`, was `build-refund`), the
 * next-step builder any wallet can relay to settle a raise itself, the typed auction read while Settling, the final
 * `/me/bids` shape, the series row's settlement fields and the arena's Settling series.
 */
describe.skipIf(!dbTestsEnabled())('S2 auction builders and reads (WP7)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  /** Sign a built transaction with `w` and relay it through the API as `tok`. */
  const relay = async (w: SimWallet, tx: UnsignedTx, tok: string) => {
    const r = await rig.post('/tx/send', (await w.sign(tx)) as SignedTx, tok);
    expect(r.statusCode).toBe(200);
    return r.json() as { events: { type: string; payload: Record<string, unknown> }[] };
  };
  const walletTok = (h: SimHarness, w: SimWallet, accountId: string, roles: ('backer' | 'issuer')[] = ['backer']) =>
    rig.token({ accountId, wallets: [{ chain: h.sim.chain, address: w.address }], roles });

  it('build-open and build-cancel are the issuer\'s, with Stage 1\'s refusals as 409s', async () => {
    const h = rig.mon;
    const { terms } = defaultTerms(h.sim);
    if (!(await h.sim.getIssuer(h.issuer.address))) await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events.find((e) => e.type === 'SeriesCreated')!.payload as { seriesId: string }).seriesId;
    await rig.sync();
    const issuerTok = walletTok(h, h.issuer, 'open-issuer', ['issuer']);
    const strangerTok = walletTok(h, h.backers[0]!, 'open-stranger');
    expect((await rig.post(`/series/${seriesId}/raise/build-open`, {})).statusCode).toBe(401);
    expect((await rig.post(`/series/${seriesId}/raise/build-open`, {}, strangerTok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/raise/build-cancel`, {}, strangerTok)).statusCode).toBe(403);
    // a Draft raise cannot be cancelled (Stage 1 RaiseNotOpen)
    const draftCancel = await rig.post(`/series/${seriesId}/raise/build-cancel`, {}, issuerTok);
    expect([draftCancel.statusCode, draftCancel.json().detail]).toEqual([409, { stage1: 'RaiseNotOpen' }]);
    // new raises paused: refused before the wallet signs (Stage 1 NewRaisesPaused)
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: true });
    try {
      const paused = await rig.post(`/series/${seriesId}/raise/build-open`, {}, issuerTok);
      expect([paused.statusCode, paused.json().detail]).toEqual([409, { stage1: 'NewRaisesPaused' }]);
    } finally {
      await h.exec(h.admin, { kind: 'pauseNewRaises', paused: false });
    }
    // the open: the issuer signs; the chain sets the ends from the series' durations
    const open = await rig.post(`/series/${seriesId}/raise/build-open`, {}, issuerTok);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ commitDurationSeconds: 3 * 86_400, revealDurationSeconds: 86_400, tx: { signer: h.issuer.address, command: { kind: 'openRaise', seriesId } } });
    const now = await h.sim.now();
    const opened = await relay(h.issuer, open.json().tx, issuerTok);
    expect(opened.events.map((e) => e.type)).toEqual(['RaiseOpened']);
    expect(opened.events[0]!.payload).toMatchObject({ commitEndsAt: now + 3 * 86_400, revealEndsAt: now + 4 * 86_400 });
    const again = await rig.post(`/series/${seriesId}/raise/build-open`, {}, issuerTok);
    expect([again.statusCode, again.json().detail]).toEqual([409, { stage1: 'RaiseNotDraft' }]);
    // nothing to settle before the reveal end: the step builder says wait, and until when
    const signerTok = walletTok(h, h.backers[0]!, 'open-signer');
    const early = await rig.post(`/series/${seriesId}/auction/build-step`, { signer: h.backers[0]!.address }, signerTok);
    expect([early.statusCode, early.json().detail]).toEqual([409, { stage: 'commit', reason: 'wait', until: now + 4 * 86_400 }]);
    // an Open raise with no bid can be cancelled, also after its reveal end (Stage 1 has no time check)
    await h.sim.setTime(now + 4 * 86_400 + 1);
    const cancel = await rig.post(`/series/${seriesId}/raise/build-cancel`, {}, issuerTok);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().tx).toMatchObject({ signer: h.issuer.address, command: { kind: 'cancelRaise', seriesId } });
    expect((await relay(h.issuer, cancel.json().tx, issuerTok)).events.map((e) => e.type)).toEqual(['RaiseCancelled']);
    const done = await rig.post(`/series/${seriesId}/auction/build-step`, { signer: h.backers[0]!.address }, signerTok);
    expect([done.statusCode, done.json().detail]).toEqual([409, { stage: 'cancelled', reason: 'done' }]);
  });

  it('build-cancel is 409 once a bid exists (Stage 1 BidsExist)', async () => {
    const h = rig.sol;
    const { seriesId } = await h.runRaise({ bids: [{ backer: 2, price: USDC(10), qty: 100n }], settle: 'none' });
    await rig.sync();
    const r = await rig.post(`/series/${seriesId}/raise/build-cancel`, {}, walletTok(h, h.issuer, 'cancel-issuer', ['issuer']));
    expect([r.statusCode, r.json().detail]).toEqual([409, { stage1: 'BidsExist' }]);
  });

  // cause S3-CV (amendment M7): every auction builder refuses a curve series with 409 NotSealedBid, as the chain does (was:
  // open 409 without a name, the settlement step 409 'curve', and a cancel built while no curve units existed)
  it('a curve-mode series runs no sealed-bid raise: every auction builder is 409 NotSealedBid', async () => {
    const h = rig.sol;
    const { seriesId } = await h.createCurve();
    await rig.sync();
    const issuerTok = walletTok(h, h.issuer, 'curve-issuer', ['issuer']);
    const bidderTok = await rig.grant({ accountId: 'curve-bidder', wallets: [{ chain: h.sim.chain, address: h.backers[0]!.address }], roles: ['backer'] });
    const notSealed = [409, { stage1: 'NotSealedBid' }];
    const bidder = h.backers[0]!.address;
    const salt = '0x' + '01'.repeat(32);
    const commitment = bidCommitment({ seriesId, bidder, pricePerUnit: USDC(10), quantity: 1n, salt });
    for (const [url, body, tok] of [
      [`/series/${seriesId}/raise/build-open`, {}, issuerTok],
      [`/series/${seriesId}/raise/build-cancel`, {}, issuerTok],
      [`/series/${seriesId}/auction/build-step`, { signer: h.issuer.address }, issuerTok],
      [`/series/${seriesId}/bids/precheck`, { bidder, pricePerUnit: USDC(10).toString(), quantity: '1' }, bidderTok],
      [`/series/${seriesId}/bids/build-commit`, { bidder, commitment, deposit: USDC(20).toString() }, bidderTok],
      [`/series/${seriesId}/bids/build-reveal`, { bidder, pricePerUnit: USDC(10).toString(), quantity: '1', salt }, bidderTok],
      [`/series/${seriesId}/bids/build-deliver`, { bidder }, bidderTok],
    ] as const) {
      const r = await rig.post(url, body, tok);
      expect([r.statusCode, r.json().detail], url).toEqual(notSealed);
    }
    const preview = await rig.get(`/series/${seriesId}/auction/preview`);
    expect([preview.statusCode, preview.json().detail]).toEqual(notSealed);
    await h.curveBuy(seriesId, h.backers[0]!, USDC(100));
    expect((await rig.post(`/series/${seriesId}/raise/build-cancel`, {}, issuerTok)).json().detail).toEqual({ stage1: 'NotSealedBid' });
    expect((await rig.get(`/series/${seriesId}`)).json().auction).toBeNull();
  });

  it('relaying every build-step transaction settles the raise to mint finalisation and delivers every bid; the reads follow', async () => {
    const h = rig.sol;
    const { seriesId } = await h.runRaise({ settle: 'none' }); // at the reveal end, nothing settled
    const relayer = h.backers[0]!;
    const tok = walletTok(h, relayer, 'step-relayer');
    // the signer must be one of the caller's wallets
    expect((await rig.post(`/series/${seriesId}/auction/build-step`, { signer: h.backers[1]!.address }, tok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/auction/build-step`, { signer: relayer.address })).statusCode).toBe(401);
    const steps: string[] = [];
    let mintFinalAfter: number | null = null;
    for (let i = 0; i < 32; i++) {
      const r = await rig.post(`/series/${seriesId}/auction/build-step`, { signer: relayer.address }, tok);
      if (r.statusCode === 409) {
        expect(r.json().detail).toEqual({ stage: 'complete', reason: 'done' });
        break;
      }
      expect(r.statusCode).toBe(200);
      const step = r.json() as { stage: string; command: { kind: string; seriesId: string }; tx: UnsignedTx };
      expect(step.tx).toMatchObject({ signer: relayer.address, command: step.command });
      expect(step.command.seriesId).toBe(seriesId);
      await relay(relayer, step.tx, tok);
      steps.push(step.command.kind);
      if (mintFinalAfter === null && (await h.sim.getAuction(seriesId))!.mintFinalized) mintFinalAfter = steps.length;
      if (step.command.kind === 'beginSettlement') {
        // mid-settlement: the typed auction read, then the indexed series row and the arena
        const a = await rig.get(`/series/${seriesId}/auction`);
        expect(a.statusCode).toBe(200);
        expect(a.json()).toMatchObject({ phase: 'Settling', raiseState: 'Settling', stage: 'tallying', phaseEndsAt: null, round: 1, roundRejected: false, bidCount: 5, revealedCount: 5, validCount: 5, mintFinalized: false });
        expect(a.json().proposal).toMatchObject({ clearingPrice: USDC(9).toString() });
        expect(a.json().now).toBe(await h.sim.now());
        await rig.sync();
        expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ phase: 'Settling', mintFinalized: false, auction: { round: 1, roundRejected: false, clearingPrice: null, finalizedAt: null } });
        const arena = (await rig.get('/arena')).json().arena as { seriesId: string; phase: string }[];
        expect(arena.find((x) => x.seriesId === seriesId)).toMatchObject({ phase: 'Settling' });
      }
    }
    // the honest proposal, one tally page (5 ≤ Solana's 24), the finalize, a process per bid, then a delivery per bid
    expect(steps).toEqual(['beginSettlement', 'tallyBids', 'finalizeSettlement', ...Array(5).fill('processBid'), ...Array(5).fill('deliverBid')]);
    expect(mintFinalAfter).toBe(8);
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settled', mintFinalized: true, escrowTotal: '0', escrowUnits: '0' });
    for (const b of h.backers) expect(await h.sim.getBid(seriesId, b.address)).toMatchObject({ processed: true, delivered: true });
    await rig.sync();
    const row = (await rig.get(`/series/${seriesId}`)).json();
    expect(row).toMatchObject({
      phase: 'Settled', mintFinalized: true, issuePrice: USDC(9).toString(), unitsSold: '500',
      terms: { commitDurationSeconds: 3 * 86_400, revealDurationSeconds: 86_400, nonRevealChargeBps: 0 },
      auction: { round: 1, roundRejected: false, rejectionReason: null, clearingPrice: USDC(9).toString(), unitsSold: '500', proceeds: USDC(4500).toString(), failureReason: null },
    });
    expect(row.auction.finalizedAt).toBe((await h.sim.getAuction(seriesId))!.finalizedAt);
    expect((await rig.get(`/series/${seriesId}/auction`)).json()).toMatchObject({ stage: 'complete', phaseEndsAt: null });
  });

  it('build-deliver: the bidder delivers its own bid, or any wallet of the caller delivers another; 409 once delivered; /me/bids follows', async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise({ settle: 'process' }); // every bid processed, none delivered
    await rig.sync();
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    const tok0 = walletTok(h, b0, 'deliver-b0');
    // the final bid shape: the chain's figures, nothing computed offchain, no `settled` (S2 review fix: with their source)
    const before = (await rig.get('/me/bids', tok0)).json().bids as Record<string, unknown>[];
    const mine = before.find((b) => b.seriesId === seriesId)!;
    expect(mine).toEqual({
      seriesId, chain: 'monad', bidder: b0.address, phase: 'Settled', deposit: USDC(1212).toString(), source: 'chain', revealed: { pricePerUnit: USDC(12).toString(), quantity: '100' }, valid: true,
      processed: true, delivered: false, allocatedUnits: '100', pendingUnits: '100', pendingRefund: USDC(303).toString(), refundable: USDC(303).toString(), refunded: '0',
    });
    expect((await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b0.address })).statusCode).toBe(401);
    // another bidder's bid needs a signer of the caller's own; a wallet not the caller's is 403
    expect((await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b1.address }, tok0)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b0.address, signer: b1.address }, tok0)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: 'nobody' }, rig.token({ accountId: 'deliver-nobody', wallets: [{ chain: 'monad', address: 'nobody' }] }))).statusCode).toBe(404);
    // the bidder's own delivery: its refund and its units
    const own = await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b0.address }, tok0);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ pendingUnits: '100', pendingRefund: USDC(303).toString(), tx: { signer: b0.address, command: { kind: 'deliverBid', seriesId, bidder: b0.address } } });
    const bal0 = BigInt(await h.sim.getBalance(b0.address, 'USDC'));
    const sent = await relay(b0, own.json().tx, tok0);
    expect(sent.events.map((e) => e.type)).toEqual(['BidDelivered']);
    expect(BigInt(await h.sim.getBalance(b0.address, 'USDC')) - bal0).toBe(USDC(303));
    const twice = await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b0.address }, tok0);
    expect([twice.statusCode, twice.json().detail]).toEqual([409, { stage1: 'AlreadyDelivered' }]);
    // b0 delivers b1's bid with its own wallet: b1 is paid, b0 only signs
    const other = await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: b1.address, signer: b0.address }, tok0);
    expect(other.json()).toMatchObject({ pendingRefund: USDC(202).toString(), tx: { signer: b0.address, command: { kind: 'deliverBid', seriesId, bidder: b1.address } } });
    const bal1 = BigInt(await h.sim.getBalance(b1.address, 'USDC'));
    const bal0b = BigInt(await h.sim.getBalance(b0.address, 'USDC'));
    await relay(b0, other.json().tx, tok0);
    expect(BigInt(await h.sim.getBalance(b1.address, 'USDC')) - bal1).toBe(USDC(202));
    expect(BigInt(await h.sim.getBalance(b0.address, 'USDC'))).toBe(bal0b);
    await rig.sync();
    const after = ((await rig.get('/me/bids', tok0)).json().bids as Record<string, unknown>[]).find((b) => b.seriesId === seriesId)!;
    expect(after).toMatchObject({ processed: true, delivered: true, pendingUnits: '0', pendingRefund: '0', refundable: '0', refunded: USDC(303).toString() });
    expect(after).not.toHaveProperty('settled');
  });

  // S2 review fix: /me/bids took processed, delivered and what is owed from the chain but allocatedUnits from the
  // indexer, so between a processBid (or a deliverBid) and the indexer's next pass one response contradicted itself
  // (processed, 100 units owed, 0 allocated; delivered, nothing owed, nothing refunded). Each bid now comes from one
  // source: the chain's read, or the indexed row as a whole when the chain has no read of it
  it('/me/bids reads each bid from one source: the chain\'s read while the indexer lags, else the indexed row as a whole', async () => {
    const h = rig.mon;
    const b0 = h.backers[0]!;
    const tok0 = walletTok(h, b0, 'one-source-b0');
    const { seriesId } = await h.runRaise({ settle: 'finalize' }); // settled, no bid processed yet
    await rig.sync();
    const mine = async () => ((await rig.get('/me/bids', tok0)).json().bids as Record<string, unknown>[]).find((b) => b.seriesId === seriesId)!;
    const owed = { processed: true, delivered: false, allocatedUnits: '100', pendingUnits: '100', pendingRefund: USDC(303).toString(), refundable: USDC(303).toString(), refunded: '0' };
    // processed on chain, not indexed yet: the chain's figures, the allocation included
    await h.exec(h.backers[4]!, { kind: 'processBid', seriesId, bidder: b0.address });
    expect(await mine()).toMatchObject({ source: 'chain', ...owed });
    await rig.sync();
    expect(await mine()).toMatchObject({ source: 'chain', ...owed });
    // delivered on chain, not indexed yet: nothing owed, and the refund delivered is not known yet (null, never "0")
    await h.exec(h.backers[4]!, { kind: 'deliverBid', seriesId, bidder: b0.address });
    const delivered = { processed: true, delivered: true, allocatedUnits: '100', pendingUnits: '0', pendingRefund: '0', refundable: '0' };
    expect(await mine()).toMatchObject({ source: 'chain', ...delivered, refunded: null });
    await rig.sync();
    const fromChain = await mine();
    expect(fromChain).toMatchObject({ source: 'chain', ...delivered, refunded: USDC(303).toString() });
    // a chain with no bid read (a live adapter before S5): the indexed row as a whole, which agrees once synced
    const realGetBid = h.sim.getBid.bind(h.sim);
    h.sim.getBid = async () => {
      throw new ChainError('NotImplemented', 'no bid read');
    };
    try {
      expect(await mine()).toEqual({ ...fromChain, source: 'index' });
      // the indexed row lags but stays whole: the next bids are settled on chain and not indexed yet
      await h.settle(seriesId, 'process');
      const b1 = (await rig.get('/me/bids', walletTok(h, h.backers[1]!, 'one-source-b1'))).json().bids.find((b: { seriesId: string }) => b.seriesId === seriesId);
      expect(b1).toMatchObject({ source: 'index', processed: false, delivered: false, allocatedUnits: '0', pendingUnits: '0', pendingRefund: '0', refundable: '0', refunded: '0' });
    } finally {
      h.sim.getBid = realGetBid;
    }
    await rig.sync();
    await h.settle(seriesId, 'deliver');
    await rig.sync();
  });

  // S2 review fix: the indexed row a /me/bids fallback reads is whole for a bid processed without an event too (a loser,
  // an invalid or unrevealed bid, every bid of a failed raise): it is owed its deposit in full from RaiseMintFinalized
  it('/me/bids from the index agrees with the chain for a bid processed without an event (a failed raise)', async () => {
    const h = rig.mon;
    const b2 = h.backers[2]!;
    const tok = walletTok(h, b2, 'one-source-failed');
    const { seriesId, failureReason } = await h.runRaise({ bids: [{ backer: 2, price: USDC(10), qty: 10n }], settle: 'process' });
    expect(failureReason).toBe('MinRaise');
    await rig.sync();
    const mine = async () => ((await rig.get('/me/bids', tok)).json().bids as Record<string, unknown>[]).find((b) => b.seriesId === seriesId)!;
    const fromChain = await mine();
    const owed = { processed: true, delivered: false, allocatedUnits: '0', pendingUnits: '0', pendingRefund: USDC(101).toString(), refundable: USDC(101).toString(), refunded: '0' };
    expect(fromChain).toMatchObject({ source: 'chain', phase: 'Failed', deposit: USDC(101).toString(), ...owed });
    const realGetBid = h.sim.getBid.bind(h.sim);
    h.sim.getBid = async () => null; // the chain has no such bid
    try {
      expect(await mine()).toEqual({ ...fromChain, source: 'index' });
    } finally {
      h.sim.getBid = realGetBid;
    }
    await h.settle(seriesId, 'deliver');
    await rig.sync();
    expect(await mine()).toMatchObject({ source: 'chain', processed: true, delivered: true, pendingRefund: '0', refunded: USDC(101).toString() });
  });
});

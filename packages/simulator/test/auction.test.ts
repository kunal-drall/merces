import { describe, expect, it } from 'vitest';
import { bidCommitment } from '@merces/domain';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

/*
 * S2 cause codes on the pins that moved:
 *  - S2-AD: commit and reveal durations are series terms (Stage 1 bounds: 1 hour–30 days, 1 hour–7 days); `openRaise`
 *    derives the phase ends from them;
 *  - S2-E: Stage 1's auction error names (`detail.stage1`) and check order;
 *  - S2-FP: a failed raise keeps its price and would-be results (`AuctionFailed`: NoValidBids or MinRaise);
 *  - S2-MS: multi-step settlement (`beginSettlement` … `deliverBid`);
 *  - S2-PR: push delivery (`deliverBid`; `claimRefund` retired);
 *  - S2-VR: validity is fixed at reveal: an over-cap bid reveals as invalid and is refunded in full; a reveal never
 *    reverts on validity.
 */
const HOUR = 3_600;

describe('auction edge cases', () => {
  it('fails below the minimum raise and refunds everyone without fees', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId, failureReason } = await h.runRaise({ bids: [{ backer: 0, price: USDC(10), qty: 10n }] });
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.phase).toBe('Failed');
    // cause S2-FP: Stage 1's RaiseFailed fields: MinRaise with the would-be price, units and proceeds
    const failed = (await h.sim.readEvents(null, 1_000)).events.find((e) => e.type === 'AuctionFailed')!;
    expect(failed.payload).toEqual({ seriesId, reason: 'MinRaise', clearingPrice: USDC(10).toString(), unitsSold: '10', proceeds: USDC(100).toString(), minimumRaise: USDC(4000).toString() });
    // cause S2-FP: the auction keeps them; the series has no issue price
    expect(failureReason).toBe('MinRaise');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Failed', clearingPrice: USDC(10).toString(), unitsSold: '10', proceeds: USDC(100).toString(), failureReason: 'MinRaise', mintFinalized: true });
    expect([s.issuePrice, s.unitsSold, s.unitsOutstanding]).toEqual([null, '0', '0']);
    // cause S2-PR: the deposit came back through delivery (was claimRefund)
    expect(await h.sim.getBid(seriesId, h.backers[0]!.address)).toMatchObject({ processed: true, delivered: true, refunded: USDC(101).toString() });
    expect(await h.sim.getBalance(h.backers[0]!.address, 'USDC')).toBe('1000000000000');
    expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDC')).toBe('0');
  });
  it('fails a raise with no bid as NoValidBids, with a price, units and proceeds of 0', async () => {
    const h = await SimHarness.create('monad');
    const { seriesId } = await h.runRaise({ bids: [] });
    const failed = (await h.sim.readEvents(null, 1_000)).events.find((e) => e.type === 'AuctionFailed')!;
    // cause S2-FP
    expect(failed.payload).toEqual({ seriesId, reason: 'NoValidBids', clearingPrice: '0', unitsSold: '0', proceeds: '0', minimumRaise: USDC(4000).toString() });
  });
  it('enforces allowlist, one bid per wallet, commitment integrity and the wallet cap', async () => {
    const h = await SimHarness.create('solana');
    // cause S2-AD: one-hour phases (Stage 1's minimum) as terms, where the test opened 100-second ones
    const { terms } = defaultTerms(h.sim, { commitDurationSeconds: HOUR, revealDurationSeconds: HOUR });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const r = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (r.events[0]!.payload as { seriesId: string }).seriesId;
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const stranger = h.sim.address('wallet:stranger');
    await h.sim.fund(stranger, 'USDC', USDC(1000));
    const tx = await h.sim.build({ kind: 'commitBid', seriesId, commitment: '0x' + '00'.repeat(32), deposit: '1' }, stranger);
    await expectChainError(h.sim.send({ tx, signatures: { [stranger]: `sim:${stranger}` } }), 'NotAllowlisted');
    const w = h.backers[0]!;
    const salt = '0x' + 'aa'.repeat(32);
    const c = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: USDC(10), quantity: 300n, salt });
    await h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: USDC(3030).toString() });
    const dup = h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: '1' });
    await expectChainError(dup, 'Duplicate');
    await expectStage1Error(dup, 'BidExists'); // cause S2-E
    const cancel = h.exec(h.issuer, { kind: 'cancelRaise', seriesId });
    await expectChainError(cancel, 'TooLate');
    await expectStage1Error(cancel, 'BidsExist'); // cause S2-E
    await h.sim.setTime(now + HOUR); // cause S2-AD (was now + 100)
    const mismatch = h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(10).toString(), quantity: '299', salt });
    await expectChainError(mismatch, 'InvalidCommitment');
    await expectStage1Error(mismatch, 'CommitmentMismatch'); // cause S2-E
    // cause S2-VR: 300 units is over the wallet cap (20% of 500 = 100): the reveal succeeds and records the bid invalid
    const revealed = await h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(10).toString(), quantity: '300', salt });
    expect(revealed.events[0]!.payload).toMatchObject({ valid: false });
    // cause S2-MS, S2-E: settlement begins after the reveal end (was settleAuction, TooEarly)
    const early = h.sim.submit({ kind: 'beginSettlement', seriesId, clearingPrice: '0', qAboveClaim: '0', qAtClaim: '0' }, 'keeper');
    await expectChainError(early, 'TooEarly');
    await expectStage1Error(early, 'SettlementNotReady');
    await h.sim.setTime(now + 2 * HOUR); // cause S2-AD (was now + 200)
    await h.settle(seriesId, 'deliver');
    // cause S2-VR, S2-FP: no valid bid, so the raise fails NoValidBids without a price, and the deposit comes back in full
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Failed');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ failureReason: 'NoValidBids', clearingPrice: null, validCount: 0, revealedCount: 1 });
    expect(await h.sim.getBalance(w.address, 'USDC')).toBe('1000000000000');
  });
  it('the issuer can cancel before bids and cannot open while new raises are paused', async () => {
    const h = await SimHarness.create('monad');
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const r = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const seriesId = (r.events[0]!.payload as { seriesId: string }).seriesId;
    // cause S2-E: Stage 1 cancels an Open raise only (RaiseNotOpen while Draft)
    await expectStage1Error(h.exec(h.issuer, { kind: 'cancelRaise', seriesId }), 'RaiseNotOpen');
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: true });
    const paused = h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD: the ends come from the terms
    await expectChainError(paused, 'Paused');
    await expectStage1Error(paused, 'NewRaisesPaused'); // cause S2-E
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: false });
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const c = await h.exec(h.issuer, { kind: 'cancelRaise', seriesId });
    expect(types(c.events)).toEqual(['RaiseCancelled']);
  });
  it('a raise with no bid can be cancelled after its reveal end; a raise with a bid cannot', async () => {
    // cause S2-E: Stage 1's cancel_raise has no time check (SIM:578-585)
    const h = await SimHarness.create('solana');
    const { seriesId } = await h.runRaise({ bids: [], settle: 'none' });
    const a = (await h.sim.getAuction(seriesId))!;
    expect(await h.sim.now()).toBe(a.revealEndsAt);
    await h.sim.setTime(a.revealEndsAt! + 86_400);
    expect(types((await h.exec(h.issuer, { kind: 'cancelRaise', seriesId })).events)).toEqual(['RaiseCancelled']);
    expect((await h.sim.getAuction(seriesId))!.raiseState).toBe('Cancelled');
    await expectStage1Error(h.exec(h.issuer, { kind: 'cancelRaise', seriesId }), 'RaiseNotOpen');
    const withBid = await h.runRaise({ bids: [{ backer: 0, price: USDC(10), qty: 10n }], settle: 'none' });
    await expectStage1Error(h.exec(h.issuer, { kind: 'cancelRaise', seriesId: withBid.seriesId }), 'BidsExist');
  });
});

import { describe, expect, it } from 'vitest';
import { finalizeSettlement, processBid, requiredEscrow, tallyBids, beginSettlement, type RevealedBid } from '@merces/math';
import {
  auctionRulesOf, commandGroups, nextSettlementStep, parseDomainEvent, permissionlessCommandKinds, permissionlessCommandSchema, processingOrder, proposalFor,
  serviceCommandSchema, settlementOutcome, settlementStage, userCommandSchema,
  type ChainLimits, type SettlementAuctionView, type SettlementBidView, type SettlementView,
} from '../src/index.ts';

/*
 * S2 cause codes:
 *  - S2-MS: multi-step settlement (Stage 1's commands, events and the planner);
 *  - S2-RH: registerHolder.
 *
 * S3 cause codes:
 *  - S3-BR: `burnRetired{holder}` (Stage 1 `burn_retired`) joins the permissionless group.
 *  - S3-CV: a curve's `completeCurve` and `collectCurveProceeds` (Stage 1 `complete_curve`, `collect_curve_proceeds`) join it too.
 *  - S3-CN: and its census `syncCurveUnits` (Stage 1 `sync_curve_units`).
 *
 * S4 cause codes:
 *  - S4-PAU: a signed pause approval `approvePause` (Stage 1 `approve_pause`) joins the permissionless group (S4 WP10).
 *  - S4-EXT: a signed extinguishment `extinguish` (Stage 1 `extinguish`) joins it too (S4 WP12).
 *
 * S3 follow-up cause code:
 *  - NRC: the non-reveal charge is modelled as Stage 1's code does (was S2-NRC, the owner hold: 0 bps applied whatever a
 *    series recorded): the rules carry the series' own rate, and `NonRevealCharged` and `FeeTaken{nonReveal}` exist.
 */
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const SOLANA: ChainLimits = { tallyPageMax: 24, maxBidsPerAuction: null };
const MONAD: ChainLimits = { tallyPageMax: 200, maxBidsPerAuction: 4096 };
const SID = 'solana:series1';
/** the harness's default auction terms: 500 units, reserve 8, minimum raise 4,000, cap 20%, fee 1%, non-reveal charge 1% */
const TERMS = { unitsOffered: '500', reservePrice: '8000000', minimumRaise: '4000000000', walletCapBps: 2000, auctionFeeBps: 100, nonRevealChargeBps: 100 };

/** A bid; `price` null = unrevealed. Revealed bids reveal in commit order unless `revealIndex` says otherwise. */
function bid(i: number, price: bigint | null, qty = 100n, over: Partial<SettlementBidView> = {}): SettlementBidView {
  const deposit = price === null ? USDC(1_010) : requiredEscrow(price, qty, TERMS.auctionFeeBps);
  return {
    bidder: `b${i}`, deposit: deposit.toString(), order: i, revealed: price === null ? null : { pricePerUnit: price.toString(), quantity: qty.toString() },
    revealIndex: price === null ? null : i, valid: price === null ? null : true, processed: false, delivered: false, ...over,
  };
}
function view(bids: SettlementBidView[], over: Partial<SettlementAuctionView> = {}, terms = TERMS): SettlementView {
  const revealed = bids.filter((b) => b.revealed !== null);
  return {
    auction: {
      seriesId: SID, raiseState: 'Open', commitEndsAt: 1_000, revealEndsAt: 2_000, bidCount: bids.length, revealedCount: revealed.length,
      validCount: revealed.filter((b) => b.valid).length, round: 0, roundRejected: false, proposal: null, tally: { talliedCount: 0 }, mintFinalized: false, ...over,
    },
    bids,
    terms,
  };
}
/** the harness's default raise: 12/11/10/10/9 USDC × 100 units each */
const HARNESS_BIDS = () => [12, 11, 10, 10, 9].map((p, i) => bid(i, USDC(p)));
const plan = (v: SettlementView, now = 2_000, deliver = true, limits = SOLANA) => nextSettlementStep(v, { now, limits, deliver });

describe('permissionless commands and the settlement events (cause S2-MS)', () => {
  it('parse with Stage 1\'s names; submit and build both take them; each command is listed once', () => {
    const cmds = [
      { kind: 'beginSettlement', seriesId: SID, clearingPrice: '9000000', qAboveClaim: '400', qAtClaim: '100' },
      { kind: 'tallyBids', seriesId: SID, maxBids: 24 },
      { kind: 'tallyBids', seriesId: SID },
      { kind: 'finalizeSettlement', seriesId: SID },
      { kind: 'processBid', seriesId: SID, bidder: 'b0' },
      { kind: 'deliverBid', seriesId: SID, bidder: 'b0' },
      { kind: 'registerHolder', seriesId: SID, wallet: 'w0' }, // cause S2-RH: Stage 1's `wallet` argument on both chains
      { kind: 'burnRetired', seriesId: SID, holder: 'w0' }, // cause S3-BR: Stage 1's `burn_retired` (EVM `burnRetired(seriesId, holder)`)
      // cause S3-CV: a curve's completion and proceeds, Stage 1's `complete_curve` and `collect_curve_proceeds` (anyone)
      { kind: 'completeCurve', seriesId: SID },
      { kind: 'collectCurveProceeds', seriesId: SID },
      // cause S3-CN: a curve's census, Stage 1's `sync_curve_units` (anyone)
      { kind: 'syncCurveUnits', seriesId: SID },
    ];
    for (const c of cmds) {
      expect(permissionlessCommandSchema.parse(c)).toEqual(c);
      expect(serviceCommandSchema.parse(c)).toEqual(c);
    }
    expect(serviceCommandSchema.parse({ kind: 'crankStatus', seriesId: SID }).kind).toBe('crankStatus');
    expect(permissionlessCommandKinds).toEqual(['openWindow', 'beginWindowSettlement', 'tallyWindow', 'finalizeWindow', 'processOrder', 'deliverOrder', 'snapshotFx', 'retireIfCapped', 'beginSettlement', 'tallyBids', 'finalizeSettlement', 'processBid', 'deliverBid', 'registerHolder', 'burnRetired', 'completeCurve', 'collectCurveProceeds', 'syncCurveUnits', 'approvePause', 'extinguish']); // cause S3-BR, S3-CV, S3-CN, S4-PAU, S4-EXT
    for (const maxBids of [0, 1.5, -1]) expect(() => permissionlessCommandSchema.parse({ kind: 'tallyBids', seriesId: SID, maxBids })).toThrow();
    expect(() => permissionlessCommandSchema.parse({ kind: 'beginSettlement', seriesId: SID, clearingPrice: '9.5', qAboveClaim: '0', qAtClaim: '0' })).toThrow();
    expect(() => userCommandSchema.parse({ kind: 'deliverBid', seriesId: SID, bidder: 'b0' })).toThrow();
    const names = commandGroups.flatMap((g) => Object.keys(g.commands));
    expect(new Set(names).size).toBe(names.length);
  });

  it('parse the new events, and AuctionFailed carries Stage 1\'s reason and would-be results', () => {
    const env = { chain: 'solana', cursor: '000000000001', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    const payloads = {
      SettlementProposed: { seriesId: SID, clearingPrice: '9000000', round: 1 },
      SettlementRejected: { seriesId: SID, round: 1, clearingPrice: '9000000', reason: 'ClaimMismatch' },
      UnitsAllocated: { seriesId: SID, bidder: 'b0', units: '100', cost: '900000000', fee: '9000000', refund: '303000000' },
      BidDelivered: { seriesId: SID, bidder: 'b0', units: '100', refund: '303000000' },
      RaiseMintFinalized: { seriesId: SID, unitsSold: '500', proceeds: '4500000000' },
      HolderRegistered: { seriesId: SID, holder: 'b0' },
      AuctionFailed: { seriesId: SID, reason: 'MinRaise', clearingPrice: '10000000', unitsSold: '10', proceeds: '100000000', minimumRaise: '4000000000' },
    };
    for (const [type, payload] of Object.entries(payloads)) expect(parseDomainEvent({ ...env, type, payload }).payload).toEqual(payload);
    expect(() => parseDomainEvent({ ...env, type: 'SettlementRejected', payload: { ...payloads.SettlementRejected, reason: 'Other' } })).toThrow();
    expect(() => parseDomainEvent({ ...env, type: 'AuctionFailed', payload: { seriesId: SID, reason: 'below-minimum-raise' } })).toThrow();
    // cause NRC (was: the charge held, so no event recorded one): Stage 1's NonRevealCharged and its fee kind
    const charged = { seriesId: SID, bidder: 'b0', charge: '10100000' };
    expect(parseDomainEvent({ ...env, type: 'NonRevealCharged', payload: charged }).payload).toEqual(charged);
    expect(() => parseDomainEvent({ ...env, type: 'NonRevealCharged', payload: { seriesId: SID, bidder: 'b0' } })).toThrow();
    const fee = { seriesId: SID, kind: 'nonReveal', amount: '10100000', payer: 'b0' };
    expect(parseDomainEvent({ ...env, type: 'FeeTaken', payload: fee }).payload).toEqual(fee);
  });
});

describe('Stage 1\'s rules for a series', () => {
  it('auctionRulesOf reads the canonical terms (strings) and the simulator\'s (bigints) alike', () => {
    const fromStrings = auctionRulesOf(TERMS);
    const fromBigints = auctionRulesOf({ unitsOffered: 500n, reservePrice: 8_000_000n, minimumRaise: 4_000_000_000n, walletCapBps: 2000n, auctionFeeBps: 100n, nonRevealChargeBps: 100n });
    expect(fromBigints).toEqual(fromStrings);
    expect(fromStrings).toEqual({ unitsOffered: 500n, reservePrice: 8_000_000n, minRaise: 4_000_000_000n, walletCapBps: 2000, auctionFeeBps: 100, nonRevealChargeBps: 100 });
  });

  // cause NRC (was S2-NRC: the hold applied 0 bps whatever the series recorded): the series' own rate reaches Stage 1's
  // processBid, which charges an unrevealed bid on a settled raise and nothing on a failed one or on a revealed bid
  it('carries the series\' own non-reveal charge into Stage 1\'s processBid', () => {
    for (const bps of [0, 100, 1000]) expect(auctionRulesOf({ ...TERMS, nonRevealChargeBps: bps }).nonRevealChargeBps).toBe(bps);
    const rules = auctionRulesOf(TERMS);
    const escrow = USDC(1_010);
    const settled = { failed: false, clearingPrice: USDC(9), R: 0n, qAt: 100n };
    const unrevealed = { escrow, revealed: false, valid: false, price: 0n, quantity: 0n };
    expect(processBid(unrevealed, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: USDC(999.9), charge: USDC(10.1) });
    expect(processBid(unrevealed, { ...settled, failed: true }, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: escrow, charge: 0n });
    // a revealed invalid bid is refunded in full on a settled raise
    expect(processBid({ escrow, revealed: true, valid: false, price: USDC(1), quantity: 100n }, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: escrow, charge: 0n });
  });

  it('proposalFor: Stage 1\'s honest proposal; no valid bid proposes (0, 0, 0)', () => {
    const revealed = (bids: SettlementBidView[]): RevealedBid[] => bids.map((b, i) => ({ price: BigInt(b.revealed!.pricePerUnit), quantity: BigInt(b.revealed!.quantity), escrow: BigInt(b.deposit), valid: b.valid === true, revealIndex: i }));
    expect(proposalFor(revealed(HARNESS_BIDS()), 500n)).toEqual({ clearingPrice: USDC(9), qAboveClaim: 400n, qAtClaim: 100n });
    expect(proposalFor([], 500n)).toEqual({ clearingPrice: 0n, qAboveClaim: 0n, qAtClaim: 0n });
    expect(proposalFor(revealed([bid(0, USDC(9), 300n, { valid: false })]), 500n)).toEqual({ clearingPrice: 0n, qAboveClaim: 0n, qAtClaim: 0n });
  });

  // S2 D7 (amendment L2): SPEC §5.2 step 5 and both chains fail a raise that sells 0 units; the TS reference settles it
  it('settlementOutcome fails a round that would sell 0 units (MinRaise), where Stage 1\'s reference settles it', () => {
    const rules = auctionRulesOf({ ...TERMS, unitsOffered: '1', minimumRaise: '0' });
    const bids: RevealedBid[] = [0, 1].map((i) => ({ price: USDC(10), quantity: 1n, escrow: requiredEscrow(USDC(10), 1n, 100), valid: true, revealIndex: i }));
    const p = beginSettlement(1n, USDC(10), 0n, 2n); // r_claim 1, each marginal bid floor(1 × 1 / 2) = 0
    const t = tallyBids(bids, p);
    expect(finalizeSettlement(t, 2, rules, p)).toMatchObject({ kind: 'settled', unitsSold: 0n });
    expect(settlementOutcome(t, 2, rules, p)).toEqual({ kind: 'failed', reason: 'MinRaise', clearingPrice: USDC(10), unitsSold: 0n, proceeds: 0n });
    // every other outcome is Stage 1's own
    const h = HARNESS_BIDS().map((b, i) => ({ price: BigInt(b.revealed!.pricePerUnit), quantity: 100n, escrow: BigInt(b.deposit), valid: true, revealIndex: i }));
    const hp = beginSettlement(500n, USDC(9), 400n, 100n);
    expect(settlementOutcome(tallyBids(h, hp), 5, auctionRulesOf(TERMS), hp)).toEqual(finalizeSettlement(tallyBids(h, hp), 5, auctionRulesOf(TERMS), hp));
  });
});

describe('nextSettlementStep: the settlement planner (cause S2-MS)', () => {
  it('waits for the reveal end, and does nothing for a Draft or Cancelled raise', () => {
    expect(plan(view(HARNESS_BIDS()), 500)).toEqual({ kind: 'wait', until: 2_000, stage: 'commit' });
    expect(plan(view(HARNESS_BIDS()), 1_999)).toEqual({ kind: 'wait', until: 2_000, stage: 'reveal' });
    expect(plan(view([], { raiseState: 'Draft', commitEndsAt: null, revealEndsAt: null }))).toEqual({ kind: 'done', stage: 'draft' });
    expect(plan(view([], { raiseState: 'Cancelled' }))).toEqual({ kind: 'done', stage: 'cancelled' });
    expect(plan(view([], { revealEndsAt: null }))).toMatchObject({ kind: 'stuck', reason: 'NoRevealEnd' });
  });

  it('proposes (0, 0, 0) when no bid was revealed, and Stage 1\'s honest proposal after the reveal end', () => {
    const zero = { kind: 'beginSettlement', seriesId: SID, clearingPrice: '0', qAboveClaim: '0', qAtClaim: '0' };
    expect(plan(view([]))).toEqual({ kind: 'submit', command: zero, stage: 'awaiting-proposal' });
    expect(plan(view([bid(0, null), bid(1, null)]))).toMatchObject({ kind: 'submit', command: zero });
    // the harness's default raise: p* = 9 USDC, 400 units above it, 100 at it
    expect(plan(view(HARNESS_BIDS()), 9_999)).toEqual({ kind: 'submit', command: { kind: 'beginSettlement', seriesId: SID, clearingPrice: '9000000', qAboveClaim: '400', qAtClaim: '100' }, stage: 'awaiting-proposal' });
  });

  it('answers a foreign rejected round with its own proposal, but never repeats a proposal the chain rejected', () => {
    const foreign = view(HARNESS_BIDS(), { raiseState: 'Settling', round: 1, roundRejected: true, proposal: { clearingPrice: '10000000', qAboveClaim: '200', qAtClaim: '200' }, tally: { talliedCount: 5 } });
    expect(plan(foreign)).toMatchObject({ kind: 'submit', command: { kind: 'beginSettlement', clearingPrice: '9000000', qAboveClaim: '400', qAtClaim: '100' }, stage: 'awaiting-proposal' });
    const ours = view(HARNESS_BIDS(), { raiseState: 'Settling', round: 2, roundRejected: true, proposal: { clearingPrice: '9000000', qAboveClaim: '400', qAtClaim: '100' }, tally: { talliedCount: 5 } });
    expect(plan(ours)).toEqual({ kind: 'stuck', reason: 'ProposalAlreadyRejected', stage: 'awaiting-proposal' });
  });

  it('tallies in pages of the chain\'s limit, a foreign round too, then finalizes', () => {
    // 30 revealed bids on Solana (24 per page): two tallies, then finalize
    const bids = Array.from({ length: 30 }, (_, i) => bid(i, USDC(8 + (i % 5)), 10n));
    const settling = (talliedCount: number, limits = SOLANA) => plan(view(bids, { raiseState: 'Settling', round: 1, proposal: { clearingPrice: '1', qAboveClaim: '0', qAtClaim: '0' }, tally: { talliedCount } }), 2_000, true, limits);
    expect(settling(0)).toEqual({ kind: 'submit', command: { kind: 'tallyBids', seriesId: SID, maxBids: 24 }, stage: 'tallying' });
    expect(settling(24)).toEqual({ kind: 'submit', command: { kind: 'tallyBids', seriesId: SID, maxBids: 24 }, stage: 'tallying' });
    expect(settling(30)).toEqual({ kind: 'submit', command: { kind: 'finalizeSettlement', seriesId: SID }, stage: 'awaiting-finalize' });
    // EVM pages hold 200
    expect(settling(0, MONAD)).toMatchObject({ command: { kind: 'tallyBids', maxBids: 200 } });
  });

  it('processes revealed bids by reveal index, then unrevealed ones by commit order; delivers only when asked', () => {
    const bids = [
      bid(0, USDC(12), 100n, { revealIndex: 2 }), bid(1, null), bid(2, USDC(11), 100n, { revealIndex: 0 }), bid(3, null), bid(4, USDC(10), 100n, { revealIndex: 1 }),
    ];
    expect(processingOrder(bids).map((b) => b.bidder)).toEqual(['b2', 'b4', 'b0', 'b1', 'b3']);
    const v = view(bids, { raiseState: 'Settled', round: 1 });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = plan(v);
      expect(step).toMatchObject({ kind: 'submit', stage: 'processing', command: { kind: 'processBid', seriesId: SID } });
      const bidder = (step as { command: { bidder: string } }).command.bidder;
      seen.push(bidder);
      bids.find((b) => b.bidder === bidder)!.processed = true;
    }
    expect(seen).toEqual(['b2', 'b4', 'b0', 'b1', 'b3']);
    // every bid processed while the chain still says the mint is open: an invariant broken, not a step to take
    expect(plan(v)).toEqual({ kind: 'stuck', reason: 'NothingToProcess', stage: 'processing' });
    v.auction.mintFinalized = true;
    expect(plan(v, 2_000, false)).toEqual({ kind: 'done', stage: 'delivering' });
    expect(plan(v)).toEqual({ kind: 'submit', command: { kind: 'deliverBid', seriesId: SID, bidder: 'b2' }, stage: 'delivering' });
    for (const b of bids) b.delivered = true;
    expect(plan(v)).toEqual({ kind: 'done', stage: 'complete' });
    v.auction.raiseState = 'Failed';
    expect(plan(v)).toEqual({ kind: 'done', stage: 'failed-complete' });
  });

  it('will not propose when the chain\'s validity disagrees with Stage 1\'s rule', () => {
    // 300 units is above the 100-unit auction cap: Stage 1 records it invalid at reveal
    const overCap = [...HARNESS_BIDS().slice(0, 4), bid(4, USDC(9), 300n)];
    expect(plan(view(overCap))).toMatchObject({ kind: 'stuck', reason: 'ValidityMismatch' });
    overCap[4]!.valid = false;
    expect(plan(view(overCap))).toMatchObject({ kind: 'submit', command: { kind: 'beginSettlement' } });
    // a valid count that differs from the chain's bids
    expect(plan(view(HARNESS_BIDS(), { validCount: 4 }))).toMatchObject({ kind: 'stuck', reason: 'ValidityMismatch' });
  });

  it('settlementStage names where a raise stands', () => {
    const v = (over: Partial<SettlementAuctionView>, bids: SettlementBidView[] = []) => settlementStage(view(bids, over), 2_500);
    expect(v({ raiseState: 'Settling', round: 1, tally: { talliedCount: 0 } }, HARNESS_BIDS())).toBe('tallying');
    expect(v({ raiseState: 'Settling', round: 1, tally: { talliedCount: 5 } }, HARNESS_BIDS())).toBe('awaiting-finalize');
    expect(v({ raiseState: 'Settling', round: 1, roundRejected: true })).toBe('awaiting-proposal');
    expect(v({ raiseState: 'Failed', mintFinalized: true })).toBe('failed-complete');
    expect(v({ raiseState: 'Open' })).toBe('awaiting-proposal');
  });
});

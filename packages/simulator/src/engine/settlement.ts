import { ChainError, auctionRulesOf, settlementOutcome, type Command } from '@merces/domain';
import {
  beginSettlement as stage1BeginSettlement, capPerUnit, processBid as stage1ProcessBid, tallyBids as stage1TallyBids,
  type BidOutcome, type RevealedBid, type Tally,
} from '@merces/math';
import { personalityLimits } from '../addresses.ts';
import { emptyTally, type SimBid, type SimSeries } from '../state.ts';
import { str, u64, type EngineCore, type Emit } from './core.ts';
import { fail, guardStage1 } from './errors.ts';
import { position, registerHolder as registerHolderBody, setUnits } from './holders.ts';
import { requireSealedBid } from './auction.ts';
import { pidAtTime } from './ledger.ts';
import { splitTranches } from './treasury.ts';

/**
 * Stage 1's multi-step settlement of a sealed-bid raise (SPEC v1.1 §5.2; Stage 1 simulator SIM:928-1028, REF
 * auction.ts:55-158) and `register_holder` (SIM:618-623). All arithmetic is Stage 1's (`@merces/math`), the rules come
 * from `auctionRulesOf` (the non-reveal charge hold applies there) and the one D7 rule from `settlementOutcome`
 * (`@merces/domain`). This module only checks the call order, stores the results, moves balances and emits events.
 *
 *   beginSettlement → tallyBids (pages) → finalizeSettlement → processBid (every bid) → deliverBid (every bid)
 *
 * Every step is permissionless (any wallet or the keeper). Ours where Stage 1's TS reference has no counterpart: the
 * paged `tallyBids` and its TallyIncomplete (the chains'), and D7 (a round that sells 0 units fails MinRaise). Every
 * step refuses a curve series first (NotSealedBid; S3 amendment M7: Stage 1 fails them on the missing auction account).
 */

type Cmd<K extends Command['kind']> = Extract<Command, { kind: K }>;

/** The revealed bids in reveal order (Stage 1 `reveal_index`). */
function revealedInOrder(s: SimSeries): SimBid[] {
  return [...s.bids.values()].filter((b) => b.revealed !== null).sort((x, y) => x.revealIndex - y.revealIndex);
}

/** A revealed bid as Stage 1's math reads it. */
function asRevealed(b: SimBid): RevealedBid {
  return { price: b.revealed!.pricePerUnit, quantity: b.revealed!.quantity, escrow: b.deposit, valid: b.valid, revealIndex: b.revealIndex };
}

// ------------------------------------------------------------------ begin
/**
 * `begin_settlement` (SIM:928-941): RaiseNotOpen unless Open or Settling, SettlementNotReady before the reveal end,
 * TallyInProgress unless no round ran or the last was rejected, then the claims as u64 (AmountOutOfRange). Stage 1's
 * `beginSettlement` makes the proposal (`r_claim`); the round number goes up, the running tally restarts and the raise
 * is Settling. `SettlementProposed`.
 */
export function beginSettlement(e: EngineCore, cmd: Cmd<'beginSettlement'>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  const a = s.auction;
  if (s.phase !== 'Open' && s.phase !== 'Settling') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (s.revealEndsAt === null || now < s.revealEndsAt) fail('SettlementNotReady', 'the reveal phase has not ended');
  if (!(a.tallyRound === 0 || a.roundRejected)) fail('TallyInProgress', 'a settlement round is in progress');
  const price = u64(cmd.clearingPrice);
  const qAbove = u64(cmd.qAboveClaim);
  const qAt = u64(cmd.qAtClaim);
  a.proposal = stage1BeginSettlement(s.terms.unitsOffered, price, qAbove, qAt);
  a.tallyRound += 1;
  a.roundRejected = false;
  a.rejectionReason = null;
  a.tally = emptyTally();
  s.phase = 'Settling';
  emit('SettlementProposed', { seriesId: s.seriesId, clearingPrice: str(price), round: a.tallyRound });
}

// ------------------------------------------------------------------ tally
/**
 * `tally_bids`, paged as the chains page it (Solana 24 bids per call, EVM 200: `ChainInfo.limits`): NotSettling unless
 * a round runs and was not rejected. Tallies the next `min(maxBids, tallyPageMax)` revealed bids not yet tallied this
 * round, in reveal order, with Stage 1's `tallyBids`, and adds the page to the round's running tally. A page with
 * nothing left to tally changes nothing (both chains skip a bid tallied this round). No event.
 */
export function tallyBids(e: EngineCore, cmd: Cmd<'tallyBids'>, _emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  const a = s.auction;
  if (s.phase !== 'Settling' || a.roundRejected || !a.proposal) fail('NotSettling', 'no settlement round is open');
  const pageMax = personalityLimits(e.state.config.personality).tallyPageMax;
  const n = Math.min(cmd.maxBids ?? pageMax, pageMax);
  const page = revealedInOrder(s).filter((b) => b.talliedRound !== a.tallyRound).slice(0, n);
  const t = stage1TallyBids(page.map(asRevealed), a.proposal);
  for (const b of page) b.talliedRound = a.tallyRound;
  const r = a.tally;
  r.qAbove += t.qAbove;
  r.qAt += t.qAt;
  r.allocSum += t.allocSum;
  r.talliedCount += t.talliedCount;
  if (t.minValidPrice !== null && (r.minValidPrice === null || t.minValidPrice < r.minValidPrice)) r.minValidPrice = t.minValidPrice;
}

// ------------------------------------------------------------------ finalize
/**
 * `finalize_settlement` (SIM:944-976, with the chains' TallyIncomplete): NotSettling unless a round runs, has a proposal
 * and was not rejected; TallyIncomplete until every revealed bid is tallied this round. The running tally must equal one
 * pass of Stage 1's `tallyBids` over every revealed bid (an invariant). Then Stage 1's outcome with D7
 * (`settlementOutcome`):
 *  - rejected (ClaimMismatch, InvalidClearingPrice): the round is marked rejected, the tally stays; `SettlementRejected`;
 *  - failed (NoValidBids, MinRaise): the results are recorded (the would-be price, units and proceeds), the raise is
 *    Failed; `AuctionFailed`; a raise with no bid at all finalises its mint at once;
 *  - settled: the results, the issue price, units sold and cap per unit, the settlement time and the first period
 *    (SIM:972); `AuctionSettled`. Units become outstanding, and the treasury its tranches, at `finalizeMint`.
 */
export function finalizeSettlement(e: EngineCore, cmd: Cmd<'finalizeSettlement'>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  const a = s.auction;
  if (s.phase !== 'Settling' || !a.proposal || a.roundRejected) fail('NotSettling', 'no settlement round is open');
  if (a.tally.talliedCount !== a.revealedCount) fail('TallyIncomplete', 'revealed bids remain to be tallied');
  const tally: Tally = { ...a.tally };
  const onePass = stage1TallyBids(revealedInOrder(s).map(asRevealed), a.proposal);
  if (onePass.qAbove !== tally.qAbove || onePass.qAt !== tally.qAt || onePass.allocSum !== tally.allocSum || onePass.minValidPrice !== tally.minValidPrice || onePass.talliedCount !== tally.talliedCount) {
    throw new ChainError('ChainSpecific', 'settlement tally invariant violated'); // never happens: pages partition the revealed bids
  }
  const o = settlementOutcome(tally, a.validCount, auctionRulesOf(s.terms), a.proposal);
  const { seriesId } = s;
  if (o.kind === 'rejected') {
    a.roundRejected = true;
    a.rejectionReason = o.reason;
    emit('SettlementRejected', { seriesId, round: a.tallyRound, clearingPrice: str(a.proposal.clearingPrice), reason: o.reason });
    return;
  }
  a.qAbove = tally.qAbove;
  a.qAt = tally.qAt;
  a.unitsSold = o.unitsSold;
  a.proceeds = o.proceeds;
  a.finalizedAt = now;
  if (o.kind === 'failed') {
    a.clearingPrice = o.reason === 'NoValidBids' ? null : o.clearingPrice;
    a.R = 0n;
    a.failureReason = o.reason;
    s.phase = 'Failed';
    emit('AuctionFailed', { seriesId, reason: o.reason, clearingPrice: str(o.clearingPrice), unitsSold: str(o.unitsSold), proceeds: str(o.proceeds), minimumRaise: str(s.terms.minimumRaise) });
    if (s.bids.size === 0) finalizeMint(s, emit);
    return;
  }
  a.clearingPrice = o.clearingPrice;
  a.R = o.R;
  s.phase = 'Settled';
  s.settledAt = now;
  s.ledger.firstPeriod = pidAtTime(now); // SIM:972
  s.issuePrice = o.clearingPrice;
  s.unitsSold = o.unitsSold;
  s.capPerUnit = capPerUnit(s.terms.capMultipleWad, o.clearingPrice); // Stage 1's floor(m × P0 / WAD)
  emit('AuctionSettled', { seriesId, clearingPrice: str(o.clearingPrice), unitsSold: str(o.unitsSold), proceeds: str(o.proceeds), settledAt: now });
}

// ------------------------------------------------------------------ process
/**
 * `process_bid` (SIM:986-1012): RaiseNotSettled unless Settled or Failed, BidNotFound, AlreadyProcessed. Stage 1's
 * `processBid` decides the bid's allocation, cost, fee and refund (the rules through `auctionRulesOf`, so the
 * non-reveal charge is 0 while held); `applyBidOutcome` records it. The last bid finalises the mint.
 */
export function processBid(e: EngineCore, cmd: Cmd<'processBid'>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  const a = s.auction;
  if (s.phase !== 'Settled' && s.phase !== 'Failed') fail('RaiseNotSettled', 'the raise is not settled or failed');
  const b = s.bids.get(cmd.bidder);
  if (!b) fail('BidNotFound', 'no bid for this wallet');
  if (b.processed) fail('AlreadyProcessed', 'the bid is already processed');
  const o = guardStage1(() => stage1ProcessBid(
    { escrow: b.deposit, revealed: b.revealed !== null, valid: b.valid, price: b.revealed?.pricePerUnit ?? 0n, quantity: b.revealed?.quantity ?? 0n },
    { failed: s.phase === 'Failed', clearingPrice: a.clearingPrice ?? 0n, R: a.R, qAt: a.qAt },
    auctionRulesOf(s.terms),
  ), 'InsufficientEscrow');
  applyBidOutcome(e, s, b, o, emit);
}

/**
 * Record Stage 1's outcome for a bid (SIM:994-1011): the bid's allocation and what it is owed; the escrow gives up the
 * cost and fee, the treasury takes the cost, the fee collector the fee. A winner's units are minted to the auction
 * escrow for it: they join its position at once (its accrual weight counts undelivered units, SPEC §6.3) and it is
 * registered as a holder; `HolderRegistered` (first time), `UnitsAllocated`, `FeeTaken{auction}` (fee > 0) and
 * `TreasuryFunded{cost}`. A loser, an invalid or unrevealed bid, and every bid of a failed raise is processed without
 * an event. The last bid finalises the mint.
 *
 * Owner hold (S2 amendment M1): the non-reveal charge is not modelled. `auctionRulesOf` applies 0 bps while
 * `NON_REVEAL_CHARGE_HELD`, so Stage 1's `processBid` returns no charge; one that is not 0 is refused here
 * (ChainSpecific, value-free) rather than credited anywhere. Lifting the hold adds the charge (A-AUC-11).
 */
export function applyBidOutcome(e: EngineCore, s: SimSeries, b: SimBid, o: BidOutcome, emit: Emit): void {
  if (o.charge !== 0n) throw new ChainError('ChainSpecific', 'a non-reveal charge is not applied while the owner hold is on', { hold: 'NON_REVEAL_CHARGE_HELD' });
  const a = s.auction;
  const { seriesId } = s;
  b.processed = true;
  b.allocation = o.alloc;
  b.pendingUnits = o.alloc;
  b.pendingRefund = o.pendingRefund;
  a.escrowTotal -= o.cost + o.fee; // the refund stays in the escrow until delivery
  s.treasuryTotal += o.cost;
  if (o.fee > 0n) e.credit(e.state.feeCollector, s.terms.stablecoinMint, o.fee);
  if (o.alloc > 0n) {
    a.escrowUnits += o.alloc;
    a.unitsMinted += o.alloc;
    const p = position(s, b.bidder);
    setUnits(s, p, p.units + o.alloc);
    registerHolderBody(s, p, emit); // Stage 1 registers every allocated bidder, allowlisted or not (SIM:1005)
    emit('UnitsAllocated', { seriesId, bidder: b.bidder, units: str(o.alloc), cost: str(o.cost), fee: str(o.fee), refund: str(o.pendingRefund) });
    if (o.fee > 0n) emit('FeeTaken', { seriesId, kind: 'auction', amount: str(o.fee), payer: b.bidder });
    emit('TreasuryFunded', { seriesId, amount: str(o.cost) });
  }
  a.bidsProcessed += 1;
  if (a.bidsProcessed === s.bids.size) finalizeMint(s, emit);
}

/**
 * `finalizeMint` (SIM:978-984): the mint is final. A settled raise checks every unit sold was minted (and every unit
 * of cost reached the treasury), makes them outstanding and splits the treasury into its release tranches;
 * `RaiseMintFinalized{unitsSold, proceeds}`. A failed raise emits it with 0 and 0, as both chains do (S2 D7; Stage 1's
 * simulator emits the would-be values).
 */
export function finalizeMint(s: SimSeries, emit: Emit): void {
  const a = s.auction;
  if (s.phase === 'Settled') {
    if (a.unitsMinted !== a.unitsSold || s.treasuryTotal !== a.proceeds) throw new ChainError('ChainSpecific', 'minted units or proceeds differ from the settlement'); // never happens
    a.mintFinalized = true;
    s.unitsOutstanding = a.unitsSold;
    s.tranches = splitTranches(s);
    emit('RaiseMintFinalized', { seriesId: s.seriesId, unitsSold: str(a.unitsSold), proceeds: str(a.proceeds) });
    return;
  }
  a.mintFinalized = true;
  emit('RaiseMintFinalized', { seriesId: s.seriesId, unitsSold: '0', proceeds: '0' });
}

// ------------------------------------------------------------------ deliver
/**
 * `deliver_bid` (SIM:1014-1028): BidNotFound, NotProcessed, AlreadyDelivered; no raise-state and no allowlist check
 * (a bidder removed from the allowlist is still delivered). `deliverBody` pays it.
 */
export function deliverBid(e: EngineCore, cmd: Cmd<'deliverBid'>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  const b = s.bids.get(cmd.bidder);
  if (!b) fail('BidNotFound', 'no bid for this wallet');
  if (!b.processed) fail('NotProcessed', 'the bid is not processed yet');
  if (b.delivered) fail('AlreadyDelivered', 'the bid is already delivered');
  deliverBody(e, s, b, emit);
}

/**
 * Deliver a processed bid: its refund leaves the escrow for the bidder, its units leave the auction escrow. Position
 * units do not move: they joined the position when the bid was processed (S2 D4). `BidDelivered`.
 */
function deliverBody(e: EngineCore, s: SimSeries, b: SimBid, emit: Emit): void {
  const a = s.auction;
  b.delivered = true;
  a.escrowTotal -= b.pendingRefund;
  e.credit(b.bidder, s.terms.stablecoinMint, b.pendingRefund);
  a.escrowUnits -= b.pendingUnits;
  emit('BidDelivered', { seriesId: s.seriesId, bidder: b.bidder, units: str(b.pendingUnits), refund: str(b.pendingRefund) });
}

/**
 * Deliver `wallet`'s processed bid if it is still pending (Stage 1 `deliverPending`, SIM:1369-1373): the redemption
 * claim and the final claim run it first.
 */
export function deliverPending(e: EngineCore, s: SimSeries, wallet: string, emit: Emit): void {
  const b = s.bids.get(wallet);
  if (b && b.processed && !b.delivered) deliverBody(e, s, b, emit);
}

// ------------------------------------------------------------------ register_holder
/**
 * `register_holder` (SIM:618-623): anyone may register an allowlisted wallet (NotAllowlisted, checked before a position
 * is created) as a holder of the series; idempotent. `HolderRegistered` the first time (both chains emit it).
 */
export function registerHolder(e: EngineCore, cmd: Cmd<'registerHolder'>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireAllowlisted(cmd.wallet);
  registerHolderBody(s, position(s, cmd.wallet), emit);
}

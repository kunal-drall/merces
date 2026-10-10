import type { AuctionState, BidState, SettlementView } from '@merces/domain';
import type { SimBid, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { auctionPhase } from '../engine/auction.ts';

/** A series' auction record as the chain reads it (`AuctionState`): the display phase beside Stage 1's stored state. */
export function toAuctionState(seriesId: string, x: SimSeries, now: number): AuctionState {
  const phase = auctionPhase(x, now);
  const a = x.auction;
  const t = a.tally;
  return {
    seriesId, phase: phase === 'SettleDue' ? 'Reveal' : phase, raiseState: x.phase, commitEndsAt: x.commitEndsAt, revealEndsAt: x.revealEndsAt,
    bidCount: x.bids.size, revealedCount: a.revealedCount, validCount: a.validCount, escrowTotal: s(a.escrowTotal), escrowUnits: s(a.escrowUnits),
    round: a.tallyRound, roundRejected: a.roundRejected, rejectionReason: a.rejectionReason,
    proposal: a.proposal ? { clearingPrice: s(a.proposal.clearingPrice), qAboveClaim: s(a.proposal.qAboveClaim), qAtClaim: s(a.proposal.qAtClaim), rClaim: s(a.proposal.rClaim) } : null,
    tally: { talliedCount: t.talliedCount, qAbove: s(t.qAbove), qAt: s(t.qAt), allocSum: s(t.allocSum), minValidPrice: t.minValidPrice === null ? null : s(t.minValidPrice) },
    clearingPrice: a.clearingPrice === null ? null : s(a.clearingPrice), qAbove: s(a.qAbove), qAt: s(a.qAt), R: s(a.R), unitsSold: s(a.unitsSold), proceeds: s(a.proceeds),
    finalizedAt: a.finalizedAt, failureReason: a.failureReason, bidsProcessed: a.bidsProcessed, unitsMinted: s(a.unitsMinted), mintFinalized: a.mintFinalized,
  };
}

/** A bid as the chain reads it (`BidState`): what it is owed reads "0" once delivered. */
export function toBid(seriesId: string, b: SimBid): BidState {
  const owed = b.processed && !b.delivered;
  return {
    seriesId, bidder: b.bidder, commitment: b.commitment, deposit: s(b.deposit), order: b.order,
    revealed: b.revealed ? { pricePerUnit: s(b.revealed.pricePerUnit), quantity: s(b.revealed.quantity) } : null,
    revealIndex: b.revealed ? b.revealIndex : null, valid: b.revealed ? b.valid : null, talliedRound: b.talliedRound, processed: b.processed,
    allocatedUnits: s(b.allocation), pendingUnits: s(owed ? b.pendingUnits : 0n), pendingRefund: s(owed ? b.pendingRefund : 0n), delivered: b.delivered,
  };
}

/** The settlement planner's view of a series (`nextSettlementStep`), from the chain's own reads. */
export function settlementViewOf(x: SimSeries, now: number): SettlementView {
  return { auction: toAuctionState(x.seriesId, x, now), bids: [...x.bids.values()].map((b) => toBid(x.seriesId, b)), terms: x.terms };
}

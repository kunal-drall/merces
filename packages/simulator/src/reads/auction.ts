import type { AuctionState, BidState } from '@merces/domain';
import type { SimBid, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { auctionPhase } from '../engine/auction.ts';

export function toAuctionState(seriesId: string, x: SimSeries, now: number): AuctionState {
  const phase = auctionPhase(x, now);
  return {
    seriesId, phase: phase === 'SettleDue' ? 'Reveal' : phase, raiseState: x.phase, commitEndsAt: x.commitEndsAt, revealEndsAt: x.revealEndsAt, bidCount: x.bids.size, revealedCount: [...x.bids.values()].filter((b) => b.revealed).length,
    clearingPrice: x.phase === 'Settled' && x.issuePrice !== null ? s(x.issuePrice) : null, unitsSold: s(x.unitsSold), proceeds: s(x.treasuryTotal),
  };
}
export function toBid(seriesId: string, b: SimBid): BidState {
  return { seriesId, bidder: b.bidder, commitment: b.commitment, deposit: s(b.deposit), order: b.order, revealed: b.revealed ? { pricePerUnit: s(b.revealed.pricePerUnit), quantity: s(b.revealed.quantity) } : null, allocatedUnits: s(b.allocatedUnits), refunded: s(b.refunded), settled: b.settled };
}

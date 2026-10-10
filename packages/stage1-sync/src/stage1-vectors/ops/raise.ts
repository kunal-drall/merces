import { bidCommitment } from '@merces/domain';
import { beginSettlement, finalizeSettlement, isBidValid, tallyBids, type AuctionRules, type RevealedBid } from '@merces/reference';
import type { SimSeries } from '@merces/simulator';
import { RunnerError } from '../errors.ts';
import { hex32 } from '../codec.ts';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * The sealed-bid raise on our one-step settlement (shims SH-AUC-2..6; S1 plan §5.3). `open_raise` is direct since S2
 * (the durations are series terms). The canonical `settleAuction`
 * settles, mints and makes refunds claimable in one transaction; Stage 1 proposes a price (`begin_settlement`),
 * tallies and finalizes (`finalize_settlement`), then processes (`process_bid`) and delivers (`deliver_bid`) bid by
 * bid. The runner keeps Stage 1's round, processing and delivery bookkeeping, and checks at `begin_settlement` that our
 * settlement is the one Stage 1's tally of the same bids gives; a proposal Stage 1 would reject cannot be represented
 * by a one-step settlement and is BLOCKED.
 */

/**
 * Stage 1's auction rules for a series, from its terms. They feed only Stage 1's validity, tally and finalize here,
 * which never read the non-reveal rate; the bps the series recorded is passed as is.
 */
export function auctionRules(s: SimSeries): AuctionRules {
  return {
    unitsOffered: s.terms.unitsOffered,
    reservePrice: s.terms.reservePrice,
    minRaise: s.terms.minimumRaise,
    walletCapBps: Number(s.terms.walletCapBps),
    auctionFeeBps: Number(s.terms.auctionFeeBps),
    nonRevealChargeBps: s.terms.nonRevealChargeBps,
  };
}

/** Our revealed bids as Stage 1 sees them, validity evaluated with Stage 1's `isBidValid` (escrow = deposit). */
export function revealedBids(s: SimSeries, rules: AuctionRules): RevealedBid[] {
  return [...s.bids.values()]
    .filter((b) => b.revealed)
    .sort((a, b) => a.order - b.order)
    .map((b, i) => ({ price: b.revealed!.pricePerUnit, quantity: b.revealed!.quantity, escrow: b.deposit, valid: isBidValid(b.revealed!.pricePerUnit, b.revealed!.quantity, b.deposit, rules), revealIndex: i }));
}

export const raiseOps: TranslatorTable = {
  open_raise: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'openRaise', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  commit_bid: (ctx, c) =>
    shim('SH-AUC-2', async () => {
      const b = ctx.seriesBook(c.series);
      const bidder = ctx.actors.address(c.actor);
      const commitment = bidCommitment({ seriesId: b.seriesId, bidder, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'commitBid', seriesId: b.seriesId, commitment, deposit: c.escrow });
    }),

  reveal_bid: (ctx, c) =>
    direct(async () => {
      const b = ctx.seriesBook(c.series);
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'revealBid', seriesId: b.seriesId, pricePerUnit: c.price, quantity: c.quantity, salt: hex32(c.salt, 'salt') });
    }),

  begin_settlement: (ctx, c) => {
    const b = ctx.seriesBook(c.series);
    const s = ctx.seriesState(c.series);
    if (b.auction.round) throw new RunnerError(`begin_settlement ${c.series}: a settlement round is already open`);
    const rules = auctionRules(s);
    const bids = revealedBids(s, rules);
    const proposal = beginSettlement(rules.unitsOffered, BigInt(c.clearingPrice), BigInt(c.qAboveClaim), BigInt(c.qAtClaim));
    const tally = tallyBids(bids, proposal);
    const outcome = finalizeSettlement(tally, bids.filter((x) => x.valid).length, rules, proposal);
    // a round Stage 1 rejects (ClaimMismatch, InvalidClearingPrice) records a rejection and waits for the next
    // proposal; the canonical one-step settlement has no such state
    if (outcome.kind === 'rejected') return { kind: 'blocked', shimId: 'SH-AUC-3', note: `Stage 1 rejects this proposal (${outcome.reason}); one-step settlement cannot represent a rejected round` };
    return shim('SH-AUC-3', async () => {
      await ctx.submit({ kind: 'settleAuction', seriesId: b.seriesId }, 'keeper');
      const after = ctx.seriesState(c.series);
      if (outcome.kind === 'settled') {
        if (after.phase !== 'Settled' || after.issuePrice !== outcome.clearingPrice || after.unitsSold !== outcome.unitsSold) {
          throw new RunnerError(`begin_settlement ${c.series}: settleAuction ended ${after.phase} with ${after.unitsSold} units at ${after.issuePrice ?? 0n}; Stage 1's tally settles ${outcome.unitsSold} units at ${outcome.clearingPrice}`);
        }
      } else if (after.phase !== 'Failed') {
        throw new RunnerError(`begin_settlement ${c.series}: settleAuction ended ${after.phase}; Stage 1's tally fails the raise (${outcome.reason})`);
      }
      const a = ctx.seriesBook(c.series).auction;
      a.tallyRound += 1;
      a.roundRejected = false;
      a.rejectionReason = null;
      a.round = { qAbove: tally.qAbove.toString(), qAt: tally.qAt.toString(), R: outcome.kind === 'settled' ? outcome.R.toString() : '0' };
    });
  },

  finalize_settlement: (ctx, c) =>
    shim('SH-AUC-4', async () => {
      const a = ctx.seriesBook(c.series).auction;
      const s = ctx.seriesState(c.series);
      if (!a.round) throw new RunnerError(`finalize_settlement ${c.series}: no settlement round is open`);
      if (s.phase !== 'Settled' && s.phase !== 'Failed') throw new RunnerError(`finalize_settlement ${c.series}: the raise is ${s.phase}, not Settled or Failed`);
      a.qAbove = a.round.qAbove;
      a.qAt = a.round.qAt;
      a.R = a.round.R;
      a.round = null;
    }),

  process_bid: (ctx, c) =>
    shim('SH-AUC-5', async () => {
      const s = ctx.seriesState(c.series);
      if (s.phase !== 'Settled' && s.phase !== 'Failed') throw new RunnerError(`process_bid ${c.series}: the raise is ${s.phase}`);
      const bid = s.bids.get(ctx.actors.address(c.bidder));
      if (!bid) throw new RunnerError(`process_bid ${c.series}: ${c.bidder} has no bid`);
      const a = ctx.seriesBook(c.series).auction;
      if (a.processed.includes(c.bidder)) throw new RunnerError(`process_bid ${c.series}: ${c.bidder} was already processed`);
      a.processed.push(c.bidder);
      a.bidsProcessed += 1;
      a.unitsMinted = (BigInt(a.unitsMinted) + bid.allocation).toString();
    }),

  deliver_bid: (ctx, c) =>
    shim('SH-AUC-6', async () => {
      const b = ctx.seriesBook(c.series);
      if (!b.auction.processed.includes(c.bidder)) throw new RunnerError(`deliver_bid ${c.series}: ${c.bidder} was not processed`);
      if (b.auction.delivered.includes(c.bidder)) throw new RunnerError(`deliver_bid ${c.series}: ${c.bidder} was already delivered`);
      const bid = ctx.seriesState(c.series).bids.get(ctx.actors.address(c.bidder));
      // the engine delivers the bid (its refund and its units: Stage 1's Retired burn and window asks count delivered
      // units only); a bid the engine already delivered (a redemption or final claim delivers first) is left alone.
      // S2 WP4b runs deliver_bid direct.
      if (bid && bid.processed && !bid.delivered) await ctx.submit({ kind: 'deliverBid', seriesId: b.seriesId, bidder: bid.bidder }, 'keeper');
      ctx.seriesBook(c.series).auction.delivered.push(c.bidder);
    }),
};

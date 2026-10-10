import { bidCommitment } from '@merces/domain';
import { RunnerError } from '../errors.ts';
import { hex32 } from '../codec.ts';
import { direct, type TranslatorTable } from './types.ts';

/**
 * The sealed-bid raise on Stage 1's multi-step settlement (S2): every op runs directly as the canonical command of the
 * same name and meaning. `commit_bid` carries Stage 1's keccak commitment (S4 WP2; shim SH-AUC-2 retired), which the
 * runner computes from the vector's plaintext and the bidder's wallet, as a Stage 1 harness does.
 *
 * - `open_raise` and `cancel_raise` are the issuer's; `commit_bid` and `reveal_bid` the bidder's.
 * - The settlement steps are permissionless and the vector calls carry no actor (SIM `types.ts:99-102`): the runner
 *   submits them as the keeper.
 * - `finalize_settlement` is Stage 1's "tally every revealed bid and finalize" (the vector README, `readme.ts:77`;
 *   SIM:944-976 tallies inline): `tallyBids` pages until every revealed bid is tallied this round, then
 *   `finalizeSettlement`. A refusal of the first page (NotSettling) is the call's refusal; pages that went through
 *   before a later refusal are undone by the runner with the rest of the op.
 * - The vector's bidder and holder names are resolved to the actors' addresses; a name without a bid reverts in the
 *   engine (BidNotFound), as in Stage 1.
 */
export const raiseOps: TranslatorTable = {
  open_raise: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'openRaise', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  cancel_raise: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'cancelRaise', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  commit_bid: (ctx, c) =>
    direct(async () => {
      const b = ctx.seriesBook(c.series);
      const bidder = ctx.actors.address(c.actor);
      // Stage 1's keccak(price ‖ quantity ‖ salt ‖ wallet); the builder decodes the price and quantity as u64s
      // (AmountOutOfRange, 21#19-#20), as Stage 1's commit_bid does
      const commitment = bidCommitment({ bidder, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'commitBid', seriesId: b.seriesId, commitment, deposit: c.escrow });
    }),

  reveal_bid: (ctx, c) =>
    direct(async () => {
      const b = ctx.seriesBook(c.series);
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'revealBid', seriesId: b.seriesId, pricePerUnit: c.price, quantity: c.quantity, salt: hex32(c.salt, 'salt') });
    }),

  begin_settlement: (ctx, c) =>
    direct(async () => {
      const seriesId = ctx.seriesBook(c.series).seriesId;
      await ctx.submit({ kind: 'beginSettlement', seriesId, clearingPrice: c.clearingPrice, qAboveClaim: c.qAboveClaim, qAtClaim: c.qAtClaim }, 'keeper');
    }),

  finalize_settlement: (ctx, c) =>
    direct(async () => {
      const seriesId = ctx.seriesBook(c.series).seriesId;
      // at least one page, so a call outside a round is refused as Stage 1 refuses it (NotSettling)
      await ctx.submit({ kind: 'tallyBids', seriesId }, 'keeper');
      for (let pages = 1; ctx.seriesState(c.series).auction.tally.talliedCount < ctx.seriesState(c.series).auction.revealedCount; pages++) {
        if (pages > ctx.seriesState(c.series).auction.revealedCount) throw new RunnerError(`finalize_settlement ${c.series}: the tally did not complete`);
        await ctx.submit({ kind: 'tallyBids', seriesId }, 'keeper');
      }
      await ctx.submit({ kind: 'finalizeSettlement', seriesId }, 'keeper');
    }),

  process_bid: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'processBid', seriesId: ctx.seriesBook(c.series).seriesId, bidder: ctx.actors.address(c.bidder) }, 'keeper');
    }),

  deliver_bid: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'deliverBid', seriesId: ctx.seriesBook(c.series).seriesId, bidder: ctx.actors.address(c.bidder) }, 'keeper');
    }),

  register_holder: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'registerHolder', seriesId: ctx.seriesBook(c.series).seriesId, wallet: ctx.actors.address(c.holder) }, 'keeper');
    }),
};

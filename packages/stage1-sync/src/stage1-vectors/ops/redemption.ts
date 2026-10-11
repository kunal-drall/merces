import { direct, type TranslatorTable } from './types.ts';

/**
 * Redemption and the tail.
 *
 * - `redeem`: direct; the optional product slippage bound is omitted, as on Stage 1.
 * - `claim_redemption`: `claimRedemption` (direct).
 * - `claim_tail`: `claimTail` (direct since S3; was shim SH-CLM-2, `claimRedemption` then `claimPayout`). The engine
 *   runs Stage 1's body in one transaction (SIM:1403-1417), the redemption first for a holder that has redeemed nothing
 *   and still has units included.
 */
export const redemptionOps: TranslatorTable = {
  redeem: (ctx, c) =>
    direct( async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'redeem', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  claim_redemption: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimRedemption', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  claim_tail: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimTail', seriesId: ctx.seriesBook(c.series).seriesId });
    }),
};

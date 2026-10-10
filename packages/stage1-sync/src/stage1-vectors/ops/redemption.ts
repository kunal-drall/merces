import { U64_MAX } from '@merces/math';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * Redemption and the tail.
 *
 * - `redeem` (SH-RED-1): `redeem{maxPricePerUnit: U64_MAX}`; Stage 1 has no slippage bound.
 * - `claim_redemption`: `claimRedemption` (direct).
 * - `claim_tail`: `claimTail` (direct since S3; was shim SH-CLM-2, `claimRedemption` then `claimPayout`). The engine
 *   runs Stage 1's body in one transaction (SIM:1403-1417), the redemption first for a holder that has redeemed nothing
 *   and still has units included.
 */
export const redemptionOps: TranslatorTable = {
  redeem: (ctx, c) =>
    shim('SH-RED-1', async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'redeem', seriesId: ctx.seriesBook(c.series).seriesId, maxPricePerUnit: U64_MAX.toString() });
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

import { U64_MAX } from '@merces/math';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * Redemption and the tail.
 *
 * - `redeem` (SH-RED-1): `redeem{maxPricePerUnit: U64_MAX}`; Stage 1 has no slippage bound.
 * - `claim_redemption`: `claimRedemption` (direct).
 * - `claim_tail` (SH-CLM-2): no `claimTail` command in S1. Like Stage 1 (SIM:1409), a holder that has not redeemed
 *   yet and still holds units redeems first (`claimRedemption`), then `claimPayout` pays the tail share. The two calls
 *   run atomically: if the payout fails, the redemption is undone too.
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
    shim('SH-CLM-2', async () => {
      const seriesId = ctx.seriesBook(c.series).seriesId;
      const wallet = ctx.actors.wallet(c.actor);
      const p = ctx.seriesState(c.series).positions.get(wallet.address);
      if (p && p.redeemedUnits === 0n && p.units > 0n) await ctx.send(wallet, { kind: 'claimRedemption', seriesId });
      await ctx.send(wallet, { kind: 'claimPayout', seriesId });
    }),
};

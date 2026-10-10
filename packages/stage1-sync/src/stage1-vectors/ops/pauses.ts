import { num } from '../codec.ts';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * Status cranks and hardship pauses.
 *
 * - `crank_status`: keeper `crankStatus` (direct).
 * - `request_pause` (SH-PAU-1): Stage 1's request has no end; `requestPause.until` (advisory in S1) is set to
 *   `t + max_pause_seconds`, the longest pause an attestor may approve.
 * - `approve_pause` (SH-PAU-2): `approvePause{until: pauseEnd}` sent by the attestor's wallet (Stage 1 passes the
 *   attestor's signature as an argument; S4).
 */
export const pauseOps: TranslatorTable = {
  crank_status: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'crankStatus', seriesId: ctx.seriesBook(c.series).seriesId }, 'keeper');
    }),

  request_pause: (ctx, c) =>
    shim('SH-PAU-1', async () => {
      const until = ctx.now() + num(ctx.vector.parameters.maxPauseSeconds.toString(), 'maxPauseSeconds');
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'requestPause', seriesId: ctx.seriesBook(c.series).seriesId, until });
    }),

  approve_pause: (ctx, c) =>
    shim('SH-PAU-2', async () => {
      await ctx.send(ctx.actors.wallet(c.attestor), { kind: 'approvePause', seriesId: ctx.seriesBook(c.series).seriesId, until: num(c.pauseEnd, 'pauseEnd') });
    }),
};

import { U64_MAX } from '@merces/math';
import { dec } from '../codec.ts';
import { RunnerError } from '../errors.ts';
import { direct, type TranslatorTable } from './types.ts';

/**
 * Status cranks and hardship pauses.
 *
 * - `crank_status`: keeper `crankStatus` (direct).
 * - `request_pause`: direct `requestPause{seriesId}`, with no advisory end. `end_pause` ends an active pause early.
 * - `approve_pause` (direct since S4 WP10; was SH-PAU-2): Stage 1 passes the attestor's signature as an argument and
 *   anyone may send it, so the runner has the named vector key sign Stage 1's PAUSE message over the chain's signing
 *   domain, the series key, the series' live pause nonce (`SeriesState.nonces.pause`) and `pauseEnd`, as Stage 1's
 *   harnesses do, and the keeper submits `approvePause{pauseEnd, attestor, signature}`. Wrong-key cases need nothing
 *   special: 08's `verifier1` signs and the chain finds no attestor (InvalidAttestorSignature). A `pauseEnd` beyond u64
 *   (21#41, 2^64) has no PAUSE message (the message encodes a u64), and the chain refuses it on the range before it reads
 *   the signature (AmountOutOfRange; the EVM's order): the runner sends the named key's signature over a placeholder
 *   digest (32 zero bytes), which the chain never looks at.
 * - `withdraw_pause_request` (direct since S4 WP10): the issuer's `withdrawPauseRequest`; it advances the pause nonce, so a
 *   signature over the withdrawn request is dead.
 */
export const pauseOps: TranslatorTable = {
  crank_status: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'crankStatus', seriesId: ctx.seriesBook(c.series).seriesId }, 'keeper');
    }),

  request_pause: (ctx, c) =>
    direct( async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'requestPause', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  end_pause: (ctx, c) => direct(async () => {
    await ctx.send(ctx.actors.wallet(c.actor), { kind: 'endPause', seriesId: ctx.seriesBook(c.series).seriesId });
  }),

  withdraw_pause_request: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'withdrawPauseRequest', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  approve_pause: (ctx, c) =>
    direct(async () => {
      const seriesId = ctx.seriesBook(c.series).seriesId;
      const pauseEnd = dec(c.pauseEnd, 'pauseEnd');
      const key = ctx.keyring.signer(c.attestor);
      let signature: string;
      if (pauseEnd > U64_MAX) {
        signature = await key.signDigest('0x' + '00'.repeat(32));
      } else {
        const [info, series] = await Promise.all([ctx.chain.info(), ctx.chain.getSeries(seriesId)]);
        if (!info.signing || !series) throw new RunnerError(`approve_pause ${c.series}: the chain has no signing context`);
        signature = (await key.attest('PAUSE', info.signing, series.seriesKey, { pauseNonce: series.nonces.pause, pauseEnd: pauseEnd.toString() })).signature;
      }
      await ctx.submit({ kind: 'approvePause', seriesId, pauseEnd: pauseEnd.toString(), attestor: key.address, signature }, 'keeper');
    }),
};

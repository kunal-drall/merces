import { direct, type TranslatorTable } from './types.ts';
import { RunnerError } from '../errors.ts';

/**
 * Treasury releases, payments, claims and burns.
 *
 * - `claim_release`: `drawRelease` (direct).
 * - `pay`: direct `payIn{seriesId}`; the chain derives the period and amount from its open due.
 * - `claim`: `claimPayout` (direct since S3 WP3; was shim SH-CLM-1 while `claimPayout` also paid the tail and the final
 *   share), Stage 1's body (SIM:1268-1282): the net payout only, a Retired balance burned, zeros emitted.
 * - `burn_retired`: `burnRetired{holder}` (direct since S3; was shim SH-BRN-1, the S1 list burn crank sent for one holder), Stage 1's
 *   body (SIM:624-636). Stage 1's op carries no actor (anyone may send it), so the runner submits it as the keeper.
 */
export const moneyOps: TranslatorTable = {
  submit_trueup: (ctx, c) => direct(async () => {
    const seriesId = ctx.seriesBook(c.series).seriesId;
    const [info, series] = await Promise.all([ctx.chain.info(), ctx.chain.getSeries(seriesId)]);
    if (!info.signing || !series) throw new RunnerError(`submit_trueup ${c.series}: no signing context`);
    const fields = { trueupNonce: String(c.nonce), year: Number(c.year), adjustment: String(c.adjustment), attestationTs: String(c.attestationTs) };
    const attestation = await ctx.keyring.signer(c.attestor).attest('TRUEUP', info.signing, series.seriesKey, fields);
    await ctx.send(ctx.actors.wallet(c.actor), { kind: 'submitTrueUp', seriesId, year: fields.year, adjustment: fields.adjustment, attestationTs: fields.attestationTs, attestor: attestation.signer, signature: attestation.signature });
  }),
  pay_trueup: (ctx, c) => direct(async () => {
    await ctx.send(ctx.actors.wallet(c.actor), { kind: 'payTrueUp', seriesId: ctx.seriesBook(c.series).seriesId });
  }),
  claim_release: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'drawRelease', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  pay: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'payIn', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  claim: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimPayout', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  burn_retired: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'burnRetired', seriesId: ctx.seriesBook(c.series).seriesId, holder: ctx.actors.address(c.holder) }, 'keeper');
    }),
};

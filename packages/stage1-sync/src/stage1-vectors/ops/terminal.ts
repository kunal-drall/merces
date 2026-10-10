import { hex32 } from '../codec.ts';
import { shim, type TranslatorTable } from './types.ts';

/**
 * Extinguishment and amendments: Stage 1 passes attestor signatures as arguments, the canonical commands are
 * co-signed by the attestors' wallets (S4 moves to signatures).
 *
 * - `extinguish` (SH-EXT-1): `extinguish{attestors}` sent by `attestors[0]` with `attestors[1]` co-signing; a repeated
 *   attestor signs once, so the chain sees the duplicate and refuses it.
 * - `claim_final` (SH-CLM-3): `claimPayout` (no `claimFinal` command in S1).
 * - `amend_terms` (SH-AMD-1): `amendTerms` signed by the issuer with the attestor co-signing.
 */
export const terminalOps: TranslatorTable = {
  extinguish: (ctx, c) =>
    shim('SH-EXT-1', async () => {
      const [a, b] = c.attestors;
      const first = ctx.actors.wallet(a);
      const second = ctx.actors.wallet(b);
      await ctx.send(first, { kind: 'extinguish', seriesId: ctx.seriesBook(c.series).seriesId, attestors: [first.address, second.address] }, a === b ? [] : [second]);
    }),

  claim_final: (ctx, c) =>
    shim('SH-CLM-3', async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimPayout', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  amend_terms: (ctx, c) =>
    shim('SH-AMD-1', async () => {
      const attestor = ctx.actors.wallet(c.attestor);
      await ctx.send(
        ctx.actors.wallet(c.actor),
        { kind: 'amendTerms', seriesId: ctx.seriesBook(c.series).seriesId, termsCommitment: hex32(c.newTermsCommitment, 'newTermsCommitment'), capMultipleWad: c.newCapMultipleWad, attestor: attestor.address },
        [attestor],
      );
    }),
};

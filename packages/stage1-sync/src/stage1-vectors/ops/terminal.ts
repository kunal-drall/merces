import { U64_MAX } from '@merces/math';
import { dec, hex32 } from '../codec.ts';
import { RunnerError } from '../errors.ts';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * Extinguishment and amendments: Stage 1 passes attestor signatures as arguments.
 *
 * - `extinguish` (SH-EXT-1): `extinguish{attestors}` sent by `attestors[0]` with `attestors[1]` co-signing; a repeated
 *   attestor signs once, so the chain sees the duplicate and refuses it (S4 WP12 moves it to signatures).
 * - `claim_final`: `claimFinal` (direct since S3; was shim SH-CLM-3, `claimPayout`), Stage 1's body (SIM:1449-1475).
 * - `amend_terms` (direct since S4 WP11; was SH-AMD-1): the actor sends `amendTerms{termsCommitment, capMultipleWad,
 *   attestor, signature}`, the signature being the named vector key's Stage 1 AMEND message over the chain's signing
 *   domain, the series key, the series' live amendment nonce (`SeriesState.nonces.amendment`), the new commitment and the
 *   new cap, as Stage 1's harnesses sign it. Wrong-key cases need nothing special: 14#52's `verifier1` signs and the chain
 *   finds no attestor (InvalidAttestorSignature); 14#51's backer sends the attestor's valid signature (NotIssuer). A cap
 *   beyond u64 has no AMEND message (the message encodes a u64) and the chain refuses it on the range before it reads
 *   the signature (AmountOutOfRange; the EVM's order): the runner sends the named key's signature over a placeholder
 *   digest (32 zero bytes), which the chain never looks at. No Stage 1 vector has one.
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
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimFinal', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  amend_terms: (ctx, c) =>
    direct(async () => {
      const seriesId = ctx.seriesBook(c.series).seriesId;
      const termsCommitment = hex32(c.newTermsCommitment, 'newTermsCommitment');
      const cap = dec(c.newCapMultipleWad, 'newCapMultipleWad');
      const key = ctx.keyring.signer(c.attestor);
      let signature: string;
      if (cap > U64_MAX) {
        signature = await key.signDigest('0x' + '00'.repeat(32));
      } else {
        const [info, series] = await Promise.all([ctx.chain.info(), ctx.chain.getSeries(seriesId)]);
        if (!info.signing || !series) throw new RunnerError(`amend_terms ${c.series}: the chain has no signing context`);
        signature = (await key.attest('AMEND', info.signing, series.seriesKey, { amendmentNonce: series.nonces.amendment, termsCommitment, capMultipleWad: cap.toString() })).signature;
      }
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'amendTerms', seriesId, termsCommitment, capMultipleWad: cap.toString(), attestor: key.address, signature });
    }),
};

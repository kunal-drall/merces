import type { Groth16ProofJson, UserCommand } from '@merces/domain';
import { U64_MAX } from '@merces/math';
import { hex32, periodIdOf } from '../codec.ts';
import { RunnerError } from '../errors.ts';
import { shim, type TranslatorTable } from './types.ts';

type SubmitReport = Extract<UserCommand, { kind: 'submitReport' }>;

/**
 * `submit_report` (shim SH-REP-1; S1 plan §5.3, §5.5).
 *
 * The report carries Stage 1's own Groth16 proof and public signals (verified for real by the chain's
 * `reportProofVerifier`, the runner's cached Stage 1 verifier); the canonical command drops `termsCommitment` (the
 * chain proves against the live one) and takes the prior and income commitments as they are. A tier-2 or tier-3
 * report's `attestation` names a vector key, which signs Stage 1's REPORT message with the report's tier over the
 * chain's signing domain (`ChainInfo.signing`) and the series key (`SeriesState.seriesKey`), as Stage 1's harnesses do
 * (S4 WP6 tier 2, S4 WP9 tier 3; keys.ts): the chain recovers it and checks the key is a usable key of the tier's kind
 * (04#68 names `attestor1` on tier 2: InvalidVerifierSignature on its own). A vector's `fxFallback` names the key that
 * signs Stage 1's FX message over the series key, the period and the report's `fxAvgWad` (S4 WP9). Nobody co-signs.
 * What remains of the shim (S5): the runner derives `fxBasis` and `pair` (a Stage 1 FX fallback on a series without an
 * FX pair, the only kind the runner creates, is refused FxFallbackNotAllowed, as Stage 1 does; FX pairs are S5).
 *
 * The vector's `witness` (TEST ONLY income openings) was deleted at load and is never read here.
 */
export const reportOps: TranslatorTable = {
  submit_report: (ctx, c) =>
    shim('SH-REP-1', async () => {
      const b = ctx.seriesBook(c.series);
      const periodId = periodIdOf(c.period);
      const priorIncomeCommitment = hex32(c.priorIncomeCommitment, 'priorIncomeCommitment');
      const incomeCommitment = hex32(c.incomeCommitment, 'incomeCommitment');
      const tier = c.tier as SubmitReport['tier'];
      if (![1, 2, 3, 4].includes(tier)) throw new RunnerError(`submit_report ${c.series}: tier is not 1-4`);
      const p = c.proof;
      const proof: Groth16ProofJson = { pi_a: p.pi_a, pi_b: p.pi_b, pi_c: p.pi_c, protocol: p.protocol as 'groth16', curve: p.curve as 'bn128' };
      const liquidityEvent = c.liquidityEvent === true;
      const signing = async () => {
        const [info, series] = await Promise.all([ctx.chain.info(), ctx.chain.getSeries(b.seriesId)]);
        if (!info.signing || !series) throw new RunnerError(`submit_report ${c.series}: the chain has no signing context`);
        return { domain: info.signing, seriesKey: series.seriesKey };
      };
      let attestation: SubmitReport['attestation'] = null;
      if ((tier === 2 || tier === 3) && c.attestation) {
        // the named vector key signs Stage 1's REPORT message with the report's tier (S4 WP6, WP9)
        const { domain, seriesKey } = await signing();
        attestation = await ctx.keyring.signer(c.attestation).attest('REPORT', domain, seriesKey, { periodId, priorIncomeCommitment, incomeCommitment, tier, liquidityEvent });
      }
      let fxFallback: SubmitReport['fxFallback'] = null;
      if (c.fxFallback) {
        // the named vector key signs Stage 1's FX message over the report's own rate (S4 WP9); a rate that is no u64 is
        // refused AmountOutOfRange at the entry checks, before the chain reads the signature, so the runner signs 0 then
        const { domain, seriesKey } = await signing();
        const rate = /^\d{1,20}$/.test(c.fxAvgWad) && BigInt(c.fxAvgWad) <= U64_MAX ? c.fxAvgWad : '0';
        fxFallback = await ctx.keyring.signer(c.fxFallback.attestor).attest('FX', domain, seriesKey, { periodId, fxRateWad: rate });
      }
      const cmd: SubmitReport = {
        kind: 'submitReport',
        seriesId: b.seriesId,
        periodId,
        tier,
        paymentStable: c.paymentUsd,
        priorIncomeCommitment,
        incomeCommitment,
        fxBasis: c.fxFallback ? 'attestor' : 'unity',
        fxAvgWad: c.fxAvgWad,
        pair: null,
        fxFallback,
        proof: { system: 'groth16-bn254', proof, publicInputs: [...c.publicSignals] },
        attestation,
        liquidityEvent,
      };
      await ctx.send(ctx.actors.wallet(c.actor), cmd);
    }),
};

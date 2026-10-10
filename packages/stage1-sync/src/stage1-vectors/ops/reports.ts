import type { Groth16ProofJson, UserCommand } from '@merces/domain';
import type { SimWallet } from '@merces/simulator';
import { hex32, periodIdOf } from '../codec.ts';
import { RunnerError } from '../errors.ts';
import { shim, type TranslatorTable } from './types.ts';

type SubmitReport = Extract<UserCommand, { kind: 'submitReport' }>;

/**
 * `submit_report` (shim SH-REP-1; S1 plan §5.3, §5.5).
 *
 * The report carries Stage 1's own Groth16 proof and public signals (verified for real by the chain's
 * `reportProofVerifier`, the runner's cached Stage 1 verifier); the canonical command drops `termsCommitment` (the
 * chain proves against the live one) and takes the prior and income commitments as they are. The source binding is the
 * shim: a tier-2 report's `attestation` names a vector key, and the runner signs attestation v1 with the ed25519 key
 * derived from it (keys.ts); a tier-3 report's attestor co-signs the transaction. A Stage 1 FX fallback on a series
 * without an FX pair (the only kind S1 creates) becomes an attestor rate the chain refuses, as Stage 1 does.
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
      const coSigners: SimWallet[] = [];
      let attestor: string | null = null;
      if (tier === 3 && c.attestation) {
        const w = ctx.actors.wallet(c.attestation);
        attestor = w.address;
        coSigners.push(w);
      }
      let attestorRate: SubmitReport['attestorRate'] = null;
      if (c.fxFallback) {
        const w = ctx.actors.wallet(c.fxFallback.attestor);
        attestorRate = { attestor: w.address, rateWad: c.fxAvgWad, pair: 'USD/USD' };
        if (!coSigners.includes(w)) coSigners.push(w);
      }
      const liquidityEvent = c.liquidityEvent === true;
      const attestation = tier === 2 && c.attestation ? ctx.keyring.ed25519(c.attestation).attest({ seriesId: b.seriesId, periodId, priorIncomeCommitment, incomeCommitment, tier, liquidityEvent }) : null;
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
        attestorRate,
        proof: { system: 'groth16-bn254', proof, publicInputs: [...c.publicSignals] },
        attestation,
        attestor,
        liquidityEvent,
      };
      await ctx.send(ctx.actors.wallet(c.actor), cmd, coSigners);
    }),
};

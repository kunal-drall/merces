import { createPublicKey, verify as edVerify } from 'node:crypto';
import { ChainError, attestationMessage, mockVerify, reportPublicInputs, type Command } from '@merces/domain';
import { WAD, parsePeriod, tailPayoutPerUnit } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { big, str, type EngineCore, type Emit } from './core.ts';
import { quarterRate } from './fx.ts';
import { accrualNow, periodRecord, syncStatus } from './status.ts';

// ------------------------------------------------------------------ reporting
export function verifyAttestation(e: EngineCore, a: NonNullable<Extract<Command, { kind: 'submitReport' }>['attestation']>, cmd: Extract<Command, { kind: 'submitReport' }>): void {
  const key = e.state.verifierKeys.get(a.keyId);
  if (!key || !key.active) throw new ChainError('InvalidAttestation', `verifier key ${a.keyId} not registered`);
  if (a.seriesId !== cmd.seriesId || a.periodId !== cmd.periodId || a.incomeCommitment !== cmd.incomeCommitment || a.tier !== cmd.tier) {
    throw new ChainError('InvalidAttestation', 'attestation fields do not match the report');
  }
  const msg = attestationMessage({ seriesId: a.seriesId, periodId: a.periodId, incomeCommitment: a.incomeCommitment, tier: a.tier });
  let ok = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'hex'), format: 'der', type: 'spki' });
    ok = edVerify(null, Buffer.from(msg), pub, Buffer.from(a.signature.replace(/^0x/, ''), 'hex'));
  } catch {
    ok = false;
  }
  if (!ok) throw new ChainError('InvalidAttestation', 'bad verifier signature');
}
/** Public input layout v0 — see reportPublicInputs() in @merces/domain. */
export function publicInputs(p: { termsCommitment: string; incomeCommitment: string; unitsOutstanding: bigint; paymentStable: bigint; fxAvgWad: bigint; periodId: string }): string[] {
  return reportPublicInputs(p);
}
export function verifyProof(e: EngineCore, cmd: Extract<Command, { kind: 'submitReport' }>, s: SimSeries): void {
  const units = s.redemption ? s.redemption.unitsAtRedemption : s.unitsOutstanding;
  const expected = publicInputs({ termsCommitment: cmd.termsCommitment, incomeCommitment: cmd.incomeCommitment, unitsOutstanding: units, paymentStable: big(cmd.paymentStable), fxAvgWad: big(cmd.fxAvgWad), periodId: cmd.periodId });
  if (expected.length !== cmd.proof.publicInputs.length || expected.some((x, i) => x !== cmd.proof.publicInputs[i])) throw new ChainError('InvalidProof', 'public inputs do not match the report');
  if (cmd.proof.system === 'mock') {
    if (!mockVerify(cmd.proof.proof, cmd.proof.publicInputs)) throw new ChainError('InvalidProof', 'mock proof failed');
  } else {
    if (!e.opts.groth16Verifier) throw new ChainError('InvalidProof', 'no Groth16 verifier configured in the simulator');
    if (!e.opts.groth16Verifier(cmd.proof.proof, cmd.proof.publicInputs)) throw new ChainError('InvalidProof', 'Groth16 proof failed');
  }
}
export function submitReport(e: EngineCore, signers: string[], cmd: Extract<Command, { kind: 'submitReport' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const issuer = signers[0];
  if (!issuer) throw new ChainError('Unauthorized', 'no signer');
  e.requireIssuer(s, issuer);
  if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
  if (s.status === 'Retired' || s.status === 'Extinguished') throw new ChainError('WrongStatus', `series is ${s.status}`);
  if (cmd.termsCommitment !== s.terms.termsCommitment) throw new ChainError('InvalidTerms', 'terms commitment mismatch');
  const tierOk = (cmd.tier === 1 && s.terms.tierFlags.tier1) || (cmd.tier === 2 && s.terms.tierFlags.tier2) || (cmd.tier === 3 && s.terms.tierFlags.tier3) || (cmd.tier === 4 && s.terms.tierFlags.tier4);
  if (!tierOk) throw new ChainError('NotPermitted', `tier ${cmd.tier} is not enabled for this series`);
  const period = parsePeriod(cmd.periodId);
  if (period.end > now) throw new ChainError('TooEarly', 'period has not ended');
  const isTail = s.status === 'Redeemed';
  if (isTail) {
    if (!cmd.liquidityEvent) throw new ChainError('WrongStatus', 'after redemption only liquidity-event (tail) reports are accepted');
    if (now > s.redemption!.tailEndsAt) throw new ChainError('TooLate', 'tail window closed');
  } else if (period.end <= s.settledAt!) {
    throw new ChainError('InvalidTerms', 'period predates settlement');
  }
  const p = periodRecord(s, cmd.periodId);
  if (p.reportAccepted) throw new ChainError('Duplicate', 'report already accepted for this period');
  // tier-specific authorisation
  if (cmd.tier === 2) {
    if (!cmd.attestation) throw new ChainError('InvalidAttestation', 'tier 2 needs a verifier attestation');
    verifyAttestation(e, cmd.attestation, cmd);
  } else if (cmd.tier === 3) {
    if (!cmd.attestor || !signers.includes(cmd.attestor)) throw new ChainError('Unauthorized', 'tier 3 needs the attestor as co-signer');
    e.requireAttestor(cmd.attestor);
  }
  // FX
  const fx = big(cmd.fxAvgWad);
  if (cmd.fxBasis === 'unity') {
    if (s.terms.reportingCurrency !== 'USD') throw new ChainError('InvalidTerms', 'unity FX only for USD reporting');
    if (fx !== WAD) throw new ChainError('InvalidTerms', 'unity FX must be 1e18');
  } else {
    if (!cmd.pair || cmd.pair !== `${s.terms.reportingCurrency}/USD`) throw new ChainError('InvalidTerms', 'pair must be <reporting currency>/USD');
    const q = quarterRate(e, cmd.pair, cmd.periodId);
    if (cmd.fxBasis === 'accumulator') {
      if (!q || q.avgWad === null || q.needsFallback) throw new ChainError('InvalidTerms', 'accumulator rate unavailable or flagged; use an attestor rate');
      if (fx !== q.avgWad) throw new ChainError('InvalidTerms', 'fxAvg does not match the accumulator');
    } else {
      if (!(q === null || q.avgWad === null || q.needsFallback)) throw new ChainError('InvalidTerms', 'accumulator rate is available; attestor rate not allowed');
      if (!cmd.attestorRate || !signers.includes(cmd.attestorRate.attestor)) throw new ChainError('Unauthorized', 'attestor rate needs the attestor as co-signer');
      e.requireAttestor(cmd.attestorRate.attestor);
      if (big(cmd.attestorRate.rateWad) !== fx || cmd.attestorRate.pair !== cmd.pair) throw new ChainError('InvalidTerms', 'attestor rate mismatch');
    }
  }
  verifyProof(e, cmd, s);
  const paymentStable = big(cmd.paymentStable);
  let accrual = 0n;
  let due: bigint;
  if (isTail) {
    const r = s.redemption!;
    const perUnit = tailPayoutPerUnit(paymentStable / r.unitsAtRedemption, r.tailCapPerUnit, r.tailPaidPerUnit);
    due = perUnit * r.unitsAtRedemption;
    p.isTail = true;
    p.outstanding = due;
  } else {
    // what is owed before lateness; accrual is recomputed at payment time (C8.3) from deadlines that freeze during a pause (C8.5)
    p.outstanding = paymentStable > p.splitReceived ? paymentStable - p.splitReceived : 0n;
    accrual = accrualNow(s, period, p.outstanding, now);
    due = p.outstanding + accrual;
  }
  p.reportAccepted = true;
  p.tier = cmd.tier;
  p.paymentStable = paymentStable;
  p.accrual = accrual;
  p.paymentDue = due;
  p.incomeCommitment = cmd.incomeCommitment;
  p.liquidityEvent = cmd.liquidityEvent;
  p.acceptedAt = now;
  if (due === 0n) p.settled = true;
  emit('ReportAccepted', { seriesId: s.seriesId, periodId: cmd.periodId, tier: cmd.tier, paymentDue: str(due), accrual: str(accrual), incomeCommitment: cmd.incomeCommitment, termsCommitment: cmd.termsCommitment, fxBasis: cmd.fxBasis, fxAvgWad: cmd.fxAvgWad, liquidityEvent: cmd.liquidityEvent });
  syncStatus(e, s, now, emit);
}

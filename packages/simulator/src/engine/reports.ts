import { createPublicKey, verify as edVerify } from 'node:crypto';
import { DEFAULTS, attestationMessage, expectedPrior, hex32ToField, mockVerify, reportPublicInputs, type Command } from '@merces/domain';
import { U64_MAX, WAD, nextExpectedPeriod, periodEnd, periodStart } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str, type EngineCore, type Emit, type ExecContext } from './core.ts';
import { fail } from './errors.ts';
import { quarterRate } from './fx.ts';
import { derivedStatus, ledgerClock, periodIdOf, pidOf } from './ledger.ts';
import { periodRecord, syncStatus } from './status.ts';

type SubmitReport = Extract<Command, { kind: 'submitReport' }>;

/**
 * `submit_report` in Stage 1's order (SPEC v1.1.2 §6.2; Stage 1 simulator `submitReport`, SIM:1050-1149), with
 * Stage 1's error names (`detail.stage1`):
 *
 *  1. the issuer signs (NotIssuer)                          9. a report already stored (WrongPeriod)
 *  2. the raise settled (RaiseNotSettled)                   10. tail: TailEnded, NoTailDue
 *  3. entry ranges (AmountOutOfRange, InvalidProof)         11. tier (TierNotEnabled)
 *  4. Stage 1's MintNotFinalized: not applicable, our       12. FX (FxMismatch, FxFallbackRequired,
 *     mint happens at settlement                                FxFallbackNotAllowed, InvalidAttestorSignature)
 *  5. derived status Retired/Extinguished (TerminalStatus)  13. the prior chain (InvalidProof)
 *  6. the next expected period (WrongPeriod)                14. the six public signals (InvalidProof)
 *  7. the period has ended (ReportTooEarly)                 15. the proof (InvalidProof)
 *  8. no open due (PaymentOutstanding)                      16. source binding: tier 2 verifier attestation
 *                                                               (InvalidVerifierSignature), tier 3 attestor
 *                                                               co-signature (InvalidAttestorSignature)
 *
 * Divergences (S1 plan §6): tier 1 is not bound to a router year-to-date checkpoint; split receipts of the period
 * stand in for Stage 1's router credit; the verifier attestation is ed25519 over attestation v1 (S4 moves it).
 * Error messages carry public facts only (period ids, tiers), never a submitted value.
 */
export function submitReport(e: EngineCore, signers: string[], cmd: SubmitReport, now: number, emit: Emit, ctx: ExecContext = {}): void {
  const s = e.series(cmd.seriesId);
  // 1-2
  if (!signers[0] || s.issuer !== signers[0]) fail('NotIssuer', 'only the issuer may report');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  // 3. entry ranges: amounts are u64, commitments field elements
  const paymentStable = u64(cmd.paymentStable);
  const fxAvgWad = u64(cmd.fxAvgWad);
  fieldOrInvalidProof(cmd.incomeCommitment);
  fieldOrInvalidProof(cmd.priorIncomeCommitment);
  // 5-9. preconditions on the derived status and the ledger clock
  const l = s.ledger;
  const status = derivedStatus(s, now);
  if (status === 'Retired' || status === 'Extinguished') fail('TerminalStatus', `series is ${status}`);
  const pid = periodPid(cmd.periodId);
  const next = nextExpectedPeriod(ledgerClock(s));
  if (pid !== next) fail('WrongPeriod', `the next period to report is ${periodIdOf(next)}`);
  if (BigInt(now) < periodEnd(pid)) fail('ReportTooEarly', `${cmd.periodId} has not ended`);
  if (l.openDueAmount > 0n) fail('PaymentOutstanding', 'the previous report is not paid');
  if (s.periods.get(cmd.periodId)?.reportAccepted) fail('WrongPeriod', 'report already stored');
  // 10. tail reports (the series redeemed)
  const isTail = status === 'Redeemed';
  if (isTail) {
    const r = s.redemption!;
    if (periodStart(pid) > BigInt(r.openedAt) + BigInt(DEFAULTS.tailSeconds)) fail('TailEnded', 'the tail window has closed');
    if (cmd.liquidityEvent && (s.tail.tailCapPerUnit === 0n || s.tail.tailExhausted)) fail('NoTailDue', 'no tail is owed');
  }
  // 11. tier: enabled for the series; tier 1 only on a pure tier-1 series (tier 4 cannot be enabled, registry.ts)
  const f = s.terms.tierFlags;
  const enabled = (cmd.tier === 1 && f.tier1) || (cmd.tier === 2 && f.tier2) || (cmd.tier === 3 && f.tier3) || (cmd.tier === 4 && f.tier4);
  if (!enabled) fail('TierNotEnabled', `tier ${cmd.tier} is not enabled for this series`);
  if (cmd.tier === 1 && (f.tier2 || f.tier3 || f.tier4)) fail('TierNotEnabled', 'tier 1 reports only on a pure tier-1 series');
  // 12. FX
  checkFx(e, s, signers, cmd, fxAvgWad);
  // 13. the prior chain (SPEC §6.2 step 5)
  const prior = expectedPrior(l, pid, cmd.priorIncomeCommitment);
  if (prior !== cmd.priorIncomeCommitment) fail('InvalidProof', 'prior income commitment does not chain');
  // 14. the public signals, against the live terms commitment
  const units = isTail ? s.redemption!.unitsAtRedemption : s.unitsOutstanding;
  const expected = expectedSignals(s, units, fxAvgWad, prior, cmd.incomeCommitment, paymentStable);
  const supplied = cmd.proof?.publicInputs ?? [];
  if (supplied.length !== expected.length || expected.some((x, i) => !sameDecimal(x, supplied[i]))) fail('InvalidProof', 'public signals do not match the report');
  // 15. the proof
  if (cmd.proof.system === 'groth16-bn254') {
    if (ctx.proofVerdict !== true) fail('InvalidProof', ctx.proofVerdict === undefined ? 'no Groth16 verifier configured' : 'Groth16 proof does not verify');
  } else if (cmd.proof.system === 'mock') {
    if (!e.opts.acceptMockProofs) fail('InvalidProof', 'mock proofs are not accepted on this chain');
    if (!mockVerify(cmd.proof.proof, supplied)) fail('InvalidProof', 'mock proof does not verify');
  } else {
    fail('InvalidProof', 'unknown proof system');
  }
  // 16. source binding, after the proof
  if (cmd.tier === 2) verifyVerifierAttestation(e, cmd, prior);
  else if (cmd.tier === 3) {
    if (!cmd.attestor || !signers.includes(cmd.attestor) || !e.state.attestors.get(cmd.attestor)) fail('InvalidAttestorSignature', 'tier 3 needs a registered attestor as co-signer');
  }

  // effects (SIM:1131-1148)
  const p = periodRecord(s, cmd.periodId);
  const credit = p.splitReceived < paymentStable ? p.splitReceived : paymentStable; // stands in for Stage 1's router credit
  const due = isTail && !cmd.liquidityEvent ? 0n : paymentStable - credit;
  p.reportAccepted = true;
  p.tier = cmd.tier;
  p.paymentStable = paymentStable;
  p.priorIncomeCommitment = prior;
  p.incomeCommitment = cmd.incomeCommitment;
  p.due = due;
  p.paymentDue = due;
  p.liquidityEvent = cmd.liquidityEvent;
  p.acceptedAt = now;
  p.isTail = isTail;
  l.lastAcceptedPeriod = pid;
  l.lastIncomeCommitment = cmd.incomeCommitment;
  l.lastIncomePeriod = pid;
  if (due === 0n) {
    l.lastPaidPeriod = pid;
    p.settled = true;
    p.paidAt = now;
  } else {
    l.openDuePeriod = pid;
    l.openDueAmount = due;
  }
  emit('ReportAccepted', {
    seriesId: s.seriesId, periodId: cmd.periodId, tier: cmd.tier, paymentDue: str(due), accrual: '0', priorIncomeCommitment: prior, incomeCommitment: cmd.incomeCommitment,
    termsCommitment: s.terms.termsCommitment, fxBasis: cmd.fxBasis, fxAvgWad: cmd.fxAvgWad, liquidityEvent: cmd.liquidityEvent,
  });
  syncStatus(e, s, now, emit);
}

/** The six signals the chain expects (Stage 1 order); a live commitment that is not a field element matches no proof. */
function expectedSignals(s: SimSeries, units: bigint, fxAvgWad: bigint, prior: string, income: string, payment: bigint): string[] {
  try {
    return reportPublicInputs({ termsCommitment: s.terms.termsCommitment, unitsOutstanding: units, fxAvgWad, priorIncomeCommitment: prior, incomeCommitment: income, paymentStable: payment });
  } catch {
    return fail('InvalidProof', 'the series terms commitment is not a field element');
  }
}

function sameDecimal(a: string, b: string | undefined): boolean {
  if (typeof b !== 'string' || !/^\d{1,78}$/.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

function u64(x: string): bigint {
  let v: bigint;
  try {
    v = BigInt(x);
  } catch {
    return fail('AmountOutOfRange', 'amount is not an integer');
  }
  if (v < 0n || v > U64_MAX) fail('AmountOutOfRange', 'amount is out of the u64 range');
  return v;
}

function fieldOrInvalidProof(h: string): void {
  try {
    hex32ToField(h);
  } catch {
    fail('InvalidProof', 'commitment is not a field element');
  }
}

function periodPid(periodId: string): number {
  try {
    return pidOf(periodId);
  } catch {
    return fail('WrongPeriod', 'malformed period id');
  }
}

/** FX (SIM:1075-1094 order). The accumulator and attestor-fallback branches are ours until S5 moves FX to Stage 1. */
function checkFx(e: EngineCore, s: SimSeries, signers: string[], cmd: SubmitReport, fx: bigint): void {
  if (s.terms.reportingCurrency === 'USD') {
    // stablecoin income: no pair, the rate is 1
    if (fx !== WAD || cmd.fxBasis === 'accumulator') fail('FxMismatch', 'stablecoin income requires unity FX');
    if (cmd.fxBasis === 'attestor' || cmd.attestorRate) fail('FxFallbackNotAllowed', 'no FX fallback for stablecoin income');
    return;
  }
  if (cmd.fxBasis === 'unity' || !cmd.pair || cmd.pair !== `${s.terms.reportingCurrency}/USD`) fail('FxMismatch', 'pair must be <reporting currency>/USD');
  const q = quarterRate(e, cmd.pair, cmd.periodId);
  const available = !!q && q.avgWad !== null && !q.needsFallback;
  if (available) {
    if (cmd.fxBasis === 'attestor' || cmd.attestorRate) fail('FxFallbackNotAllowed', 'the accumulator rate is available');
    if (fx !== q.avgWad) fail('FxMismatch', 'fxAvg does not match the accumulator');
    return;
  }
  if (cmd.fxBasis !== 'attestor' || !cmd.attestorRate) fail('FxFallbackRequired', 'the accumulator rate is unavailable or flagged; an attestor rate is required');
  const a = cmd.attestorRate;
  if (!signers.includes(a.attestor) || !e.state.attestors.get(a.attestor)) fail('InvalidAttestorSignature', 'the FX rate needs a registered attestor as co-signer');
  if (BigInt(a.rateWad) !== fx || a.pair !== cmd.pair) fail('FxMismatch', 'attestor rate does not match the report');
}

/** Tier 2: an active registered verifier key signed attestation v1 over exactly this report's fields. */
function verifyVerifierAttestation(e: EngineCore, cmd: SubmitReport, prior: string): void {
  const a = cmd.attestation;
  if (!a) return fail('InvalidVerifierSignature', 'tier 2 needs a verifier attestation');
  const key = e.state.verifierKeys.get(a.keyId);
  if (!key || !key.active) fail('InvalidVerifierSignature', 'verifier key is not registered');
  if (a.seriesId !== cmd.seriesId || a.periodId !== cmd.periodId || a.priorIncomeCommitment !== prior || a.incomeCommitment !== cmd.incomeCommitment || a.tier !== cmd.tier || a.liquidityEvent !== cmd.liquidityEvent) {
    fail('InvalidVerifierSignature', 'attestation fields do not match the report');
  }
  const msg = attestationMessage({ seriesId: a.seriesId, periodId: a.periodId, priorIncomeCommitment: a.priorIncomeCommitment, incomeCommitment: a.incomeCommitment, tier: a.tier, liquidityEvent: a.liquidityEvent });
  let ok = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(key!.publicKey, 'hex'), format: 'der', type: 'spki' });
    ok = edVerify(null, Buffer.from(msg), pub, Buffer.from(a.signature.replace(/^0x/, ''), 'hex'));
  } catch {
    ok = false;
  }
  if (!ok) fail('InvalidVerifierSignature', 'bad verifier signature');
}

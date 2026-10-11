import { DEFAULTS, expectedPrior, fxDigest, hex32ToField, mockVerify, reportDigest, reportPublicInputs, type Command } from '@merces/domain';
import { WAD, nextExpectedPeriod, periodEnd, periodStart } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str, u64, type EngineCore, type Emit, type ExecContext } from './core.ts';
import { fail } from './errors.ts';
import { quarterRate } from './fx.ts';
import { requireSigned, signingContextOf } from './keys.ts';
import { derivedStatus, ledgerClock, mintFinalized, periodIdOf, pidOf } from './ledger.ts';
import { periodRecord, syncStatus } from './status.ts';

type SubmitReport = Extract<Command, { kind: 'submitReport' }>;

/**
 * `submit_report` in Stage 1's order (SPEC v1.1.2 §6.2; Stage 1 simulator `submitReport`, SIM:1050-1149), with
 * Stage 1's error names (`detail.stage1`):
 *
 *  1. the issuer signs (NotIssuer)                          9. a report already stored (WrongPeriod)
 *  2. the raise settled (RaiseNotSettled)                   9a. curve mode, not a tail report: a census taken at or
 *  3. entry ranges (AmountOutOfRange, InvalidProof)              after the period's end, of more than 0 units
 *  4. the mint is final: the last bid is processed               (CurveUnitsNotSynced)
 *     (MintNotFinalized)                                    10. tail: TailEnded, NoTailDue
 *  5. derived status Retired/Extinguished (TerminalStatus)  11. tier (TierNotEnabled)
 *  6. the next expected period (WrongPeriod)                12. FX (FxMismatch, FxFallbackRequired,
 *  7. the period has ended (ReportTooEarly)                     FxFallbackNotAllowed; the fallback's FX signature:
 *  8. no open due (PaymentOutstanding)                          InvalidAttestorSignature)
 *                                                           13. the prior chain (InvalidProof)
 *                                                           14. the six public signals (InvalidProof)
 *                                                           15. the proof (InvalidProof)
 *                                                           16. source binding: the REPORT signature, tier 2 by a
 *                                                               verifier key (InvalidVerifierSignature), tier 3 by an
 *                                                               attestor key (InvalidAttestorSignature)
 *
 * Step 9a is Solana's curve-mode gate (`require_units_synced_for`, curve.rs:1532-1541, called from income.rs:228-233
 * before the tail block): the census is the proof's public input and the vault's N, so it must be counted after the
 * period ended (`syncCurveUnits`); the regular report then proves over that census. Stage 1's reference simulator has
 * no curve mode, so the step sits where Solana runs it, after its due and period checks.
 *
 * Divergences (S1 plan §6): tier 1 is not bound to a router year-to-date checkpoint; split receipts of the period
 * stand in for Stage 1's router credit. Tiers 2 and 3 are Stage 1's REPORT signature (S4 WP6, WP9) and the FX fallback
 * Stage 1's per-series FX signature (S4 WP9); the accumulator itself stays ours until S5.
 * Error messages carry public facts only (period ids, tiers), never a submitted value.
 */
export function submitReport(e: EngineCore, signer: string | null, cmd: SubmitReport, now: number, emit: Emit, ctx: ExecContext = {}): void {
  const s = e.series(cmd.seriesId);
  // 1-2
  if (!signer || s.issuer !== signer) fail('NotIssuer', 'only the issuer may report');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  // 3. entry ranges: amounts are u64, commitments field elements
  const paymentStable = u64(cmd.paymentStable);
  const fxAvgWad = u64(cmd.fxAvgWad);
  fieldOrInvalidProof(cmd.incomeCommitment);
  fieldOrInvalidProof(cmd.priorIncomeCommitment);
  // 4. the mint is final (SIM:1062)
  if (!mintFinalized(s)) fail('MintNotFinalized', 'the raise is still processing its bids');
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
  const isTail = status === 'Redeemed';
  // 9a. curve mode: the census postdates the period's end (curve.rs:1532-1541)
  if (s.curve && !isTail && !(s.unitsSyncedAt !== null && BigInt(s.unitsSyncedAt) >= periodEnd(pid) && s.unitsOutstanding > 0n)) {
    fail('CurveUnitsNotSynced', `the curve's units must be counted again after ${cmd.periodId} ended (syncCurveUnits)`);
  }
  // 10. tail reports (the series redeemed)
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
  checkFx(e, s, cmd, fxAvgWad, now);
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
  // 16. source binding, after the proof: Stage 1's REPORT signature over the report's own fields, tier 2 by a report
  // verifier key, tier 3 by an attestor key, usable for the period (active, or revoked after the period ended and within
  // the 45-day grace: SPEC §1.4; SIM:1115-1118 and :332-338 reportKeyValid; income.rs:396-424; MercesIncome.sol:207-228). Tiers 1 and
  // 4 ignore any attestation, as both chains do.
  if (cmd.tier === 2 || cmd.tier === 3) {
    const m = reportDigest(signingContextOf(e.state, s.seriesId), { periodId: cmd.periodId, priorIncomeCommitment: cmd.priorIncomeCommitment, incomeCommitment: cmd.incomeCommitment, tier: cmd.tier, liquidityEvent: cmd.liquidityEvent });
    requireSigned(e, cmd.tier === 2 ? 'verifier' : 'attestor', m.digest, cmd.attestation, now, { reportPeriod: cmd.periodId });
  }

  // effects (SIM:1131-1148)
  const p = periodRecord(s, cmd.periodId);
  const credit = l.routerCredit < paymentStable ? l.routerCredit : paymentStable;
  l.routerCredit -= credit;
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

/**
 * FX (SIM:1075-1094 order). The accumulator and its fallback flag are ours until S5 moves FX to Stage 1; the fallback
 * itself is Stage 1's (S4 WP9): an attestor key's `MERCES_FX_V1` signature over the series key, the period and the
 * report's own `fxAvgWad` (`fxDigest`), present exactly when the accumulator has no usable average. The key must be an
 * attestor usable for the period with the report keys' grace: both chains give the FX fallback the 45-day grace
 * (income.rs:340-356 `require_key(.., Some((period, now)))`; MercesIncome.sol:163-168 `_keyValid`), Stage 1's reference
 * requires an active key (SIM:1092 `requireActiveAttestor`): DIV-S1I-3, ours follows both chains. A signature for
 * another series, period, rate or chain recovers to another address: InvalidAttestorSignature.
 */
function checkFx(e: EngineCore, s: SimSeries, cmd: SubmitReport, fx: bigint, now: number): void {
  if (s.terms.reportingCurrency === 'USD') {
    // stablecoin income: no pair, the rate is 1
    if (fx !== WAD || cmd.fxBasis === 'accumulator') fail('FxMismatch', 'stablecoin income requires unity FX');
    if (cmd.fxBasis === 'attestor' || cmd.fxFallback) fail('FxFallbackNotAllowed', 'no FX fallback for stablecoin income');
    return;
  }
  if (cmd.fxBasis === 'unity' || !cmd.pair || cmd.pair !== `${s.terms.reportingCurrency}/USD`) fail('FxMismatch', 'pair must be <reporting currency>/USD');
  const q = quarterRate(e, cmd.pair, cmd.periodId);
  const available = !!q && q.avgWad !== null && !q.needsFallback;
  if (available) {
    if (cmd.fxBasis === 'attestor' || cmd.fxFallback) fail('FxFallbackNotAllowed', 'the accumulator rate is available');
    if (fx !== q.avgWad) fail('FxMismatch', 'fxAvg does not match the accumulator');
    return;
  }
  if (cmd.fxBasis !== 'attestor' || !cmd.fxFallback) fail('FxFallbackRequired', 'the accumulator rate is unavailable or flagged; an attestor\'s FX signature is required');
  const m = fxDigest(signingContextOf(e.state, s.seriesId), { periodId: cmd.periodId, fxRateWad: fx });
  requireSigned(e, 'attestor', m.digest, cmd.fxFallback, now, { reportPeriod: cmd.periodId });
}

import { trueUpDigest, type Command } from '@merces/domain';
import { DAY, U64_MAX, lateAccrualTrueup, periodEnd, pidAt, yearOf } from '@merces/math';
import { TERMINAL, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { requireSigned, signingContextOf } from './keys.ts';
import { ledgerClock, mintFinalized, statusParams } from './ledger.ts';
import { vaultReceive } from './payments.ts';
import { syncStatus } from './status.ts';

/** Stage 1 income.rs submit_trueup / MercesIncome.submitTrueUp. Nonces are read from chain state. */
export function submitTrueUp(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'submitTrueUp' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Settled') fail('RaiseNotSettled');
  if (!mintFinalized(s)) fail('MintNotFinalized');
  if (!s.terms.tierFlags.tier3) fail('TierNotEnabled');
  const adj = BigInt(cmd.adjustment);
  const ts = BigInt(cmd.attestationTs);
  if (adj < -(1n << 63n) || adj >= (1n << 63n) || ts < 0n || ts > U64_MAX) fail('AmountOutOfRange');
  const l = s.ledger;
  const digest = trueUpDigest(signingContextOf(e.state, s.seriesId), { trueupNonce: l.trueupNonce, year: cmd.year, adjustment: adj, attestationTs: ts });
  requireSigned(e, 'attestor', digest.digest, { signer: cmd.attestor, signature: cmd.signature }, now);
  // Both contracts enforce these guards; the TS reference omits them.
  if (TERMINAL.has(s.status)) fail('TerminalStatus');
  if (ts > BigInt(now)) fail(e.state.config.family === 'solana' ? 'TrueUpTimestampInFuture' : 'AttestationInFuture');
  if (l.trueupDue > 0n) fail('TrueUpOutstanding');
  if ((l.lastTrueupYear !== null && l.lastTrueupYear >= cmd.year) || cmd.year >= yearOf(pidAt(BigInt(now)))) fail('TrueUpYearInvalid');
  const last = cmd.year * 4 + 3;
  if (last >= l.firstPeriod! && (l.lastAcceptedPeriod === null || l.lastAcceptedPeriod < last)) fail('TrueUpYearInvalid');
  if (adj < 0n) {
    let accepted = 0n;
    for (const p of s.periods.values()) if (p.reportAccepted && p.pid >= cmd.year * 4 && p.pid <= last) accepted += p.paymentStable;
    if (-adj > accepted) fail('TrueUpAdjustmentTooLarge');
    if (l.routerCredit - adj > U64_MAX) fail('AmountOutOfRange');
    l.routerCredit -= adj;
  }
  l.trueupNonce += 1n;
  l.lastTrueupYear = cmd.year;
  const deadline = adj > 0n ? ts + BigInt(statusParams(s).trueupDays) * DAY : 0n;
  if (deadline > U64_MAX) fail('AmountOutOfRange');
  if (adj > 0n) {
    l.trueupDue = adj;
    l.trueupAttestedAt = ts;
    l.trueupYear = cmd.year;
    l.trueupNoticeEmitted = false;
  }
  emit('TrueUpRecorded', { seriesId: s.seriesId, year: cmd.year, adjustment: cmd.adjustment, deadline: Number(deadline) });
  syncStatus(e, s, now, emit);
}

/** Anyone may pay the stored due, with Stage 1's unpaused lateness accrual and attestation-period year anchor. */
export function payTrueUp(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'payTrueUp' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.phase !== 'Settled') fail('RaiseNotSettled');
  if (!mintFinalized(s)) fail('MintNotFinalized');
  const l = s.ledger;
  if (l.trueupDue === 0n) fail('NothingDue');
  const accrual = lateAccrualTrueup(ledgerClock(s), BigInt(now), statusParams(s));
  const total = l.trueupDue + accrual;
  if (total > U64_MAX) fail('AmountOutOfRange');
  const anchor = periodEnd(pidAt(l.trueupAttestedAt)) + BigInt(statusParams(s).reportDueDays) * DAY;
  e.debit(signer, s.terms.stablecoinMint, total);
  l.trueupDue = 0n;
  l.trueupAttestedAt = 0n;
  l.trueupYear = null;
  // No quarterly period: a true-up must not pay/overwrite the report due for that quarter.
  vaultReceive(e, s, total, anchor, { periodId: null, source: 'payIn', payer: signer }, now, emit);
  emit('TrueUpPaid', { seriesId: s.seriesId, amount: total.toString(), accrual: accrual.toString() });
  syncStatus(e, s, now, emit);
}

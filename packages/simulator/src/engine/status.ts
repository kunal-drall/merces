import { ChainError, PAUSE_APPROVAL_MESSAGE, pauseBounds, pauseDigest, type Command } from '@merces/domain';
import {
  U64_MAX, earliestUnpaid, formalNoticeDue, trueupNoticeDue, isLateUnderlying, isPausedAt, lateAccrual, pauseApprovalError, periodsBetween, projectDeadlines, toPid,
  type Period,
} from '@merces/math';
import type { SimPeriod, SimSeries } from '../state.ts';
import { TERMINAL, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { derivedStatus, ledgerClock, periodIdOf, setStatus, statusParams } from './ledger.ts';
import { requireSigned, signingContextOf } from './keys.ts';

export { setStatus };

/**
 * Status, formal notice, hardship pauses and the release block (SPEC v1.1 §6.4), on Stage 1's own functions.
 *
 * Status is derived from the ledger clock at `now` (`derivedStatus`, Stage 1 `deriveStatus`); the stored status
 * (`SimSeries.status`) is what the last sync point recorded and is authoritative only for the terminal states.
 * `syncStatus` mirrors Stage 1's `sync_status` (SIM:375-395) and runs only at Stage 1's sync points (`SYNC_POINTS`).
 * A hardship pause ends by itself at its approved end (`isPausedAt` clips at `now`); `crankPause` only announces it.
 */

/** Completed quarters a settled series must report, oldest first (A-REP-1: the settlement quarter counts). */
export function reportablePeriods(s: SimSeries, now: number): Period[] {
  if (s.settledAt === null) return [];
  return periodsBetween(s.settledAt, now).filter((p) => p.end <= now);
}
export function periodRecord(s: SimSeries, periodId: string): SimPeriod {
  let p = s.periods.get(periodId);
  if (!p) {
    p = {
      periodId, pid: toPid(periodId), reportAccepted: false, tier: null, paymentStable: 0n, paymentDue: 0n, paid: 0n, splitReceived: 0n, settled: false,
      incomeCommitment: null, priorIncomeCommitment: null, due: 0n, accrualPaid: 0n, paidAt: null, liquidityEvent: false, acceptedAt: null, isTail: false,
    };
    s.periods.set(periodId, p);
  }
  return p;
}
export function isPeriodSettled(s: SimSeries, periodId: string): boolean {
  const p = s.periods.get(periodId);
  return !!p && p.settled;
}

// ------------------------------------------------------------------ deadlines and accrual (Stage 1)
/** A period's deadline instants (unix seconds): last OnTime instant, last InGrace instant, first formal-notice instant. */
export interface PeriodDeadlines {
  dueAt: number;
  graceEndsAt: number;
  formalNoticeAt: number;
}

/**
 * The instants at which `period`'s countdown (unpaused seconds since the period end) passes Stage 1's bounds, given the
 * pauses recorded as of `now` (`projectDeadlines`, pinned to `deriveStatus`/`formalNoticeDue`). Formal notice is
 * period end + 90 days of unpaused time.
 */
export function deadlines(s: SimSeries, period: Period, now: number): PeriodDeadlines {
  const d = projectDeadlines(toPid(period.id), s.ledger.pauses, BigInt(now), statusParams(s));
  return { dueAt: Number(d.dueAt), graceEndsAt: Number(d.graceEndsAt), formalNoticeAt: Number(d.formalNoticeAt) };
}

/**
 * Lateness accrual on `amount` owed for `period` at `now`: Stage 1's `lateAccrual` (hurdle × whole late days / 365,
 * late days counted in unpaused time after report due + grace).
 */
export function accrualNow(s: SimSeries, period: Period, amount: bigint, now: number): bigint {
  return lateAccrual(toPid(period.id), amount, ledgerClock(s), BigInt(now), statusParams(s));
}

// ------------------------------------------------------------------ release block
/**
 * Releases are blocked by lateness: the derived status is Late, or the series is late underneath a hardship pause
 * (Stage 1 `is_late_underlying`, which ignores Paused). Never before settlement; never on a terminal series.
 */
export function releasesBlockedByLateness(s: SimSeries, now: number): boolean {
  if (s.phase !== 'Settled') return false;
  return derivedStatus(s, now) === 'Late' || isLateUnderlying(ledgerClock(s), BigInt(now), statusParams(s));
}

/**
 * Events only: record the lateness block in `ledger.releasesBlockedLate` and announce a change with
 * `ReleasesPaused('Late')` / `ReleasesResumed`, unless the issuer has paused releases (then the issuer's pause is
 * what readers see). `drawRelease` never reads the stored flag; it checks the block live.
 */
export function syncReleaseBlock(s: SimSeries, now: number, emit: Emit): void {
  const blocked = releasesBlockedByLateness(s, now);
  const l = s.ledger;
  if (blocked === l.releasesBlockedLate) return;
  l.releasesBlockedLate = blocked;
  if (s.releasesPausedByIssuer) return;
  if (blocked) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'Late' });
  else emit('ReleasesResumed', { seriesId: s.seriesId });
}

// ------------------------------------------------------------------ sync_status
/**
 * Stage 1's `sync_status` (SIM:375-395): on a settled series, store the derived status (`StatusChanged`); unless the
 * stored status is terminal, record the formal notice of the earliest unpaid period once (`formalNoticeEmittedFor`,
 * `FormalNoticeDue`) when its countdown reached the notice bound. The annual clock emits TrueUpNoticeDue once,
 * followed by release-block events. Runs only at the sync points (`SYNC_POINTS` in ledger.ts).
 */
export function syncStatus(_e: EngineCore, s: SimSeries, now: number, emit: Emit): void {
  if (s.phase !== 'Settled') return;
  setStatus(s, derivedStatus(s, now), emit);
  if (!TERMINAL.has(s.status)) {
    const l = s.ledger;
    const c = ledgerClock(s);
    const p = earliestUnpaid(c);
    if (formalNoticeDue(p, c, BigInt(now), statusParams(s)) && l.formalNoticeEmittedFor !== p) {
      l.formalNoticeEmittedFor = p;
      emit('FormalNoticeDue', { seriesId: s.seriesId, periodId: periodIdOf(p) });
    }
    if (trueupNoticeDue(c, BigInt(now), statusParams(s)) && !l.trueupNoticeEmitted && l.trueupYear !== null) {
      l.trueupNoticeEmitted = true;
      emit('TrueUpNoticeDue', { seriesId: s.seriesId, year: l.trueupYear });
    }
  }
  syncReleaseBlock(s, now, emit);
}

// ------------------------------------------------------------------ pauses and status
/**
 * `request_pause` (SIM:650-661): the issuer asks for a hardship pause. Not refused while paused or while a request is
 * pending. Advances the pause nonce, so a PAUSE signature over an older request no longer recovers to its key (S4 D7).
 * The requested end is kept in the private hardship review only. Emits `PauseRequested{nonce}` with the new nonce.
 */
export function requestPause(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'requestPause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may request a pause');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  const status = derivedStatus(s, now);
  if (TERMINAL.has(status)) fail('TerminalStatus', `series is ${status}`);
  const l = s.ledger;
  l.pauseRequested = true;
  l.pauseRequestedAt = BigInt(now);
  l.pauseNonce += 1n;
  l.pauseRequestedUntil = null;
  emit('PauseRequested', { seriesId: s.seriesId, nonce: l.pauseNonce.toString() });
}

/**
 * `withdraw_pause_request` (SIM:662-670; income.rs:964-977; MercesIncome.sol:484-493; S4 WP10): the issuer withdraws its
 * pending request. NotIssuer, then PauseNotRequested; the request is cleared with its requested time (as both chains
 * clear `pause_requested_at`) and our advisory end, and the nonce advances, so a PAUSE signature collected for the
 * withdrawn request is dead. Not a sync point. Emits `PauseRequestWithdrawn{nonce}` with the new nonce (the EVM's and the
 * reference's value; Solana emits the old one, an adapter note).
 */
export function withdrawPauseRequest(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'withdrawPauseRequest' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may withdraw its pause request');
  const l = s.ledger;
  if (!l.pauseRequested) fail('PauseNotRequested', 'no pause request is pending');
  l.pauseRequested = false;
  l.pauseRequestedAt = 0n;
  l.pauseRequestedUntil = null;
  l.pauseNonce += 1n;
  emit('PauseRequestWithdrawn', { seriesId: s.seriesId, nonce: l.pauseNonce.toString() });
}

/**
 * `approve_pause` (SIM:1284-1297; income.rs:991-1052; MercesIncome.sol:499-521; S4 WP10, D8): anyone submits an attestor
 * key's PAUSE signature over the series' live pause nonce and the end, in the chains' order:
 *  1. `pauseEnd` is a u64 (AmountOutOfRange; the EVM's `toU64` comes first, MercesIncome.sol:500: a message cannot encode
 *     2^64, so nothing can be recovered for it; Stage 1's reference checks the attestor first, which 21#41 does not
 *     tell apart);
 *  2. the signature over `MERCES_PAUSE_V1(domain, series key, pause nonce, pauseEnd)` recovers to `cmd.attestor`, an
 *     active attestor key (no grace: a PAUSE needs an active key), else InvalidAttestorSignature;
 *  3. PauseNotRequested;
 *  4. Stage 1's `pauseApprovalError` (end in the future, not already paused, ≤ 1 year, ≤ 2 years in total, ≤ 16 pauses)
 *     with the bounds and messages the attestor service checks its decisions against (`@merces/domain` pause-rules.ts).
 * The pause counts from now; `pausedTotal` grows by its whole length at approval. The request is cleared (with its
 * requested time, as both chains clear it) and the nonce stays: a replay of the same signature is PauseNotRequested.
 * Then `syncStatus` (Paused).
 */
export function approvePause(e: EngineCore, cmd: Extract<Command, { kind: 'approvePause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const l = s.ledger;
  const end = BigInt(cmd.pauseEnd);
  if (end > U64_MAX) fail('AmountOutOfRange', 'pause end is out of the u64 range');
  const m = pauseDigest(signingContextOf(e.state, s.seriesId), { pauseNonce: l.pauseNonce, pauseEnd: end });
  const attestor = requireSigned(e, 'attestor', m.digest, { signer: cmd.attestor, signature: cmd.signature }, now); // active only: no grace
  if (!l.pauseRequested) fail('PauseNotRequested', 'no pause request is pending');
  const t = BigInt(now);
  const err = pauseApprovalError(l.pauses, l.pausedTotal, t, end, pauseBounds());
  if (err) fail(err, PAUSE_APPROVAL_MESSAGE[err]);
  l.pauses.push({ start: t, end });
  l.pausedTotal += end - t;
  l.pauseRequested = false;
  l.pauseRequestedAt = 0n;
  l.pauseRequestedUntil = null;
  emit('PauseApproved', { seriesId: s.seriesId, attestor, start: now, until: Number(end) });
  syncStatus(e, s, now, emit);
}

/** Stage 1 end_pause (SIM:674): issuer ends the currently active pause, releasing unused pause allowance. */
export function endPause(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'endPause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  const t = BigInt(now);
  const open = s.ledger.pauses.find((p) => p.start <= t && t < p.end);
  if (!open) fail('NotPaused', 'no pause is active');
  s.ledger.pausedTotal -= open.end - t;
  open.end = t;
  // Announce any elapsed intervals and this shortened interval exactly once.
  crankPause(e, { kind: 'crankPause', seriesId: s.seriesId }, now, emit);
}

/**
 * Announce the end of hardship pauses (events only; not a Stage 1 op). A pause already stops at its approved end on
 * its own; this emits `PauseEnded{pausedSeconds}` for every recorded pause that ended and was not announced yet, then
 * runs `syncStatus`. A pause still running: TooEarly. Nothing to announce: WrongStatus.
 */
export function crankPause(e: EngineCore, cmd: Extract<Command, { kind: 'crankPause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const l = s.ledger;
  const t = BigInt(now);
  let announced = 0;
  while (l.pauseEndedEmitted < l.pauses.length) {
    const p = l.pauses[l.pauseEndedEmitted]!;
    if (p.end > t) break;
    emit('PauseEnded', { seriesId: s.seriesId, pausedSeconds: Number(p.end - p.start) });
    l.pauseEndedEmitted += 1;
    announced += 1;
  }
  if (announced > 0) return syncStatus(e, s, now, emit);
  if (isPausedAt(l.pauses, t)) throw new ChainError('TooEarly', 'the pause has not ended');
  fail('NotPaused', 'no pause has ended since the last announcement');
}

/** `crank_status` (SIM:645-648): `syncStatus` only; a successful no-op before settlement. */
export function crankStatus(e: EngineCore, cmd: Extract<Command, { kind: 'crankStatus' }>, now: number, emit: Emit): void {
  syncStatus(e, e.series(cmd.seriesId), now, emit);
}

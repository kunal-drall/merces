import { ChainError, type Command } from '@merces/domain';
import {
  U64_MAX, earliestUnpaid, formalNoticeDue, isLateUnderlying, isPausedAt, lateAccrual, pauseApprovalError, periodsBetween, projectDeadlines, toPid,
  type Period,
} from '@merces/math';
import type { SimPeriod, SimSeries } from '../state.ts';
import { TERMINAL, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { derivedStatus, ledgerClock, pauseBounds, periodIdOf, setStatus, statusParams } from './ledger.ts';

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
      periodId, pid: toPid(periodId), reportAccepted: false, tier: null, paymentStable: 0n, outstanding: 0n, accrual: 0n, paymentDue: 0n, paid: 0n, splitReceived: 0n, settled: false,
      incomeCommitment: null, priorIncomeCommitment: null, due: 0n, accrualPaid: 0n, paidAt: null, liquidityEvent: false, formalNoticeEmitted: false, acceptedAt: null, isTail: false,
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
 * `FormalNoticeDue`) when its countdown reached the notice bound. Then the release-block events. The true-up notice is
 * not reachable until S5 (`trueupDue` stays 0). Runs only at the sync points (`SYNC_POINTS` in ledger.ts).
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
  }
  syncReleaseBlock(s, now, emit);
}

// ------------------------------------------------------------------ pauses and status
/**
 * `request_pause` (SIM:650-661): the issuer asks for a hardship pause. Not refused while paused or while a request is
 * pending. `cmd.until` is advisory: stored (`ledger.pauseRequestedUntil`) and emitted, never enforced onchain; the
 * attestor service holds the approval to it.
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
  l.pauseRequestedUntil = BigInt(cmd.until);
  emit('PauseRequested', { seriesId: s.seriesId, until: cmd.until });
}

/**
 * `approve_pause` (SIM:1284-1297): an active attestor approves the pending request with the pause end. Bounds from
 * Stage 1's `pauseApprovalError` (end in the future, not already paused, ≤ 1 year, ≤ 2 years in total, ≤ 16 pauses).
 * The pause counts from now; `pausedTotal` grows by its whole length at approval. Then `syncStatus` (Paused).
 */
export function approvePause(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'approvePause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const l = s.ledger;
  if (!e.state.attestors.get(signer)) fail('InvalidAttestorSignature', 'the approver is not an active attestor');
  if (!l.pauseRequested) fail('PauseNotRequested', 'no pause request is pending');
  if (!Number.isSafeInteger(cmd.until) || cmd.until < 0 || BigInt(cmd.until) > U64_MAX) fail('AmountOutOfRange', 'pause end is out of the u64 range');
  const t = BigInt(now);
  const end = BigInt(cmd.until);
  const err = pauseApprovalError(l.pauses, l.pausedTotal, t, end, pauseBounds());
  if (err) fail(err, PAUSE_ERROR_MESSAGE[err]);
  l.pauses.push({ start: t, end });
  l.pausedTotal += end - t;
  l.pauseRequested = false;
  l.pauseRequestedUntil = null;
  emit('PauseApproved', { seriesId: s.seriesId, attestor: signer, until: cmd.until });
  syncStatus(e, s, now, emit);
}
const PAUSE_ERROR_MESSAGE = {
  InvalidPauseEnd: 'pause end must be in the future',
  AlreadyPaused: 'a pause is already running',
  PauseTooLong: 'pause exceeds the per-pause or cumulative limit',
  TooManyPauses: 'the series has used all its pauses',
} as const;

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

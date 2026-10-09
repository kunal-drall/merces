import { ChainError, type Command, type LifecycleStatus } from '@merces/domain';
import { daysLate, deadlinesFor, lateAccrual, periodStanding, periodsBetween, type Deadlines, type Period } from '@merces/math';
import type { SimPeriod, SimSeries } from '../state.ts';
import { TERMINAL, type EngineCore, type Emit } from './core.ts';

/** Completed quarters a settled series must report, oldest first (A-REP-1: the settlement quarter counts). */
export function reportablePeriods(s: SimSeries, now: number): Period[] {
  if (s.settledAt === null) return [];
  return periodsBetween(s.settledAt, now).filter((p) => p.end <= now);
}
export function periodRecord(s: SimSeries, periodId: string): SimPeriod {
  let p = s.periods.get(periodId);
  if (!p) {
    p = { periodId, reportAccepted: false, tier: null, paymentStable: 0n, outstanding: 0n, accrual: 0n, paymentDue: 0n, paid: 0n, splitReceived: 0n, settled: false, incomeCommitment: null, liquidityEvent: false, formalNoticeEmitted: false, acceptedAt: null, isTail: false };
    s.periods.set(periodId, p);
  }
  return p;
}
/** Seconds of approved pause overlapping [from, now). Deadlines shift by this (C8.5). */
export function pausedSecondsSince(s: SimSeries, from: number, now: number): number {
  let total = 0;
  const intervals = [...s.pauseIntervals];
  if (s.status === 'Paused' && s.pause?.startedAt != null) intervals.push({ from: s.pause.startedAt, to: now });
  for (const iv of intervals) {
    const a = Math.max(iv.from, from);
    const b = Math.min(iv.to, now);
    if (b > a) total += b - a;
  }
  return total;
}
/** Simple-interest accrual on the outstanding amount, from the end of grace to `now`; the deadlines already shift by paused seconds. */
export function accrualNow(s: SimSeries, period: Period, outstanding: bigint, now: number): bigint {
  return lateAccrual(outstanding, s.terms.hurdleWad, daysLate(deadlines(s, period, now).graceEndsAt, now));
}
export function deadlines(s: SimSeries, period: Period, now: number): Deadlines {
  return deadlinesFor(period, { dueDays: s.terms.dueDays, graceDays: s.terms.graceDays, formalNoticeDays: s.terms.formalNoticeDays, pausedSeconds: pausedSecondsSince(s, period.end, now) });
}
export function isPeriodSettled(s: SimSeries, periodId: string): boolean {
  const p = s.periods.get(periodId);
  return !!p && p.settled;
}
/** Derive OnTime/InGrace/Late from unsettled completed periods. */
export function derivedStanding(s: SimSeries, now: number): { status: 'OnTime' | 'InGrace' | 'Late'; worst: Period | null } {
  let status: 'OnTime' | 'InGrace' | 'Late' = 'OnTime';
  let worst: Period | null = null;
  for (const p of reportablePeriods(s, now)) {
    if (isPeriodSettled(s, p.id)) continue;
    const st = periodStanding(deadlines(s, p, now), now, false);
    if (st === 'Late' || st === 'FormalNoticeDue') {
      status = 'Late';
      worst = worst ?? p;
    } else if (st === 'InGrace' && status === 'OnTime') {
      status = 'InGrace';
      worst = worst ?? p;
    }
  }
  return { status, worst };
}
export function setStatus(s: SimSeries, to: LifecycleStatus, emit: Emit): void {
  if (s.status === to) return;
  const from = s.status;
  s.status = to;
  emit('StatusChanged', { seriesId: s.seriesId, from, to });
}
/** After a payment or report: if the issuer is current again, lift the Late pause. */
export function syncStatus(_e: EngineCore, s: SimSeries, now: number, emit: Emit): void {
  if (TERMINAL.has(s.status) || s.status === 'Paused') return;
  const { status } = derivedStanding(s, now);
  setStatus(s, status, emit);
  if (status === 'Late') {
    if (!s.releasesPausedLate) {
      s.releasesPausedLate = true;
      if (!s.releasesPausedByIssuer) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'Late' });
    }
  } else if (s.releasesPausedLate) {
    s.releasesPausedLate = false;
    if (!s.releasesPausedByIssuer) emit('ReleasesResumed', { seriesId: s.seriesId });
  }
}

// ------------------------------------------------------------------ pauses and status
export function requestPause(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'requestPause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Settled' || TERMINAL.has(s.status) || s.status === 'Paused') throw new ChainError('WrongStatus', `cannot request a pause while ${s.status}`);
  if (cmd.until <= now) throw new ChainError('InvalidTerms', 'pause end must be in the future');
  s.pause = { requestedUntil: cmd.until, approvedUntil: null, startedAt: null };
  emit('PauseRequested', { seriesId: s.seriesId, until: cmd.until });
}
export function approvePause(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'approvePause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireAttestor(signer);
  if (!s.pause || s.pause.requestedUntil === null || s.pause.startedAt !== null) throw new ChainError('WrongStatus', 'no pending pause request');
  if (cmd.until <= now || cmd.until > s.pause.requestedUntil) throw new ChainError('InvalidTerms', 'approved end must be in the future and not after the requested end');
  s.pause.approvedUntil = cmd.until;
  s.pause.startedAt = now;
  emit('PauseApproved', { seriesId: s.seriesId, attestor: signer, until: cmd.until });
  setStatus(s, 'Paused', emit);
}
export function crankPause(e: EngineCore, cmd: Extract<Command, { kind: 'crankPause' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Paused' || !s.pause?.startedAt || s.pause.approvedUntil === null) throw new ChainError('WrongStatus', 'not paused');
  if (now < s.pause.approvedUntil) throw new ChainError('TooEarly', 'pause has not ended');
  const paused = s.pause.approvedUntil - s.pause.startedAt;
  s.pauseIntervals.push({ from: s.pause.startedAt, to: s.pause.approvedUntil });
  s.pausedSecondsTotal += paused;
  s.pause = null;
  emit('PauseEnded', { seriesId: s.seriesId, pausedSeconds: paused });
  s.status = 'OnTime';
  const { status } = derivedStanding(s, now);
  s.status = 'Paused';
  setStatus(s, status, emit);
  syncStatus(e, s, now, emit);
}
export function crankStatus(e: EngineCore, cmd: Extract<Command, { kind: 'crankStatus' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
  if (TERMINAL.has(s.status) || s.status === 'Paused') return;
  syncStatus(e, s, now, emit);
  for (const per of reportablePeriods(s, now)) {
    if (isPeriodSettled(s, per.id)) continue;
    const st = periodStanding(deadlines(s, per, now), now, false);
    const p = periodRecord(s, per.id);
    if (st === 'FormalNoticeDue' && !p.formalNoticeEmitted) {
      p.formalNoticeEmitted = true;
      emit('FormalNoticeDue', { seriesId: s.seriesId, periodId: per.id });
    }
  }
}

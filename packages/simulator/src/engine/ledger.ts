import type { LifecycleStatus } from '@merces/domain';
import { DEFAULTS, ZERO_INCOME_COMMITMENT, fieldToHex32 } from '@merces/domain';
import {
  SeriesStatus, capPerUnit, deriveStatus, fromPid, pidAt, statusParamsOf, toPid,
  type LedgerClock, type PauseBounds, type StatusParams,
} from '@merces/math';
import type { SimLedger, SimSeries } from '../state.ts';
import type { EngineCore, Emit } from './core.ts';

/**
 * The series ledger and its Stage 1 clock (SPEC v1.1 §6.4; Stage 1 simulator SIM:340-372, 445-454).
 *
 * Status in Stage 1 is derived, not stored: the stored status is authoritative only for the terminal states
 * (Retired, Redeemed, Extinguished), and everything else follows from the ledger clock (first period, last accepted
 * period, the open due, the pauses) at `now`. These helpers build that clock from `SimSeries.ledger` and hand it to
 * Stage 1's own functions.
 */

/** A 32-byte field element as the 0x-prefixed lowercase hex the canonical model carries (`@merces/domain` `fieldToHex32`). */
export const fieldHex = fieldToHex32;

/** `Poseidon(0, 0)`: the prior income commitment at the start of a reporting year (`@merces/domain` `ZERO_INCOME_COMMITMENT`). */
export const ZERO_INCOME_COMMITMENT_HEX = ZERO_INCOME_COMMITMENT;

/** A fresh ledger (Stage 1 initial values, SIM:811-841). */
export function newLedger(): SimLedger {
  return {
    firstPeriod: null, lastAcceptedPeriod: null, lastPaidPeriod: null, openDuePeriod: null, openDueAmount: 0n,
    lastIncomeCommitment: ZERO_INCOME_COMMITMENT_HEX, lastIncomePeriod: null,
    pauses: [], pausedTotal: 0n, pauseNonce: 0n, pauseRequested: false, pauseRequestedAt: 0n, pauseRequestedUntil: null, pauseEndedEmitted: 0,
    formalNoticeEmittedFor: null, releasesBlockedLate: false, amendmentNonce: 0n, extinguishNonce: 0n,
    routerCredit: 0n, trueupNonce: 0n, trueupDue: 0n, trueupAttestedAt: 0n, lastTrueupYear: null,
  };
}

// ------------------------------------------------------------------ period ids
/** `"2026Q1"` → 8104 (Stage 1 period id). */
export function pidOf(periodId: string): number {
  return toPid(periodId);
}
/** 8104 → `"2026Q1"`. */
export function periodIdOf(pid: number): string {
  return fromPid(pid);
}
/** The Stage 1 period id containing `ts` (unix seconds). */
export function pidAtTime(ts: number): number {
  return pidAt(BigInt(ts));
}

// ------------------------------------------------------------------ the clock
/** Stage 1's status parameters for a series (due, grace and notice days are fixed by Stage 1; hurdle from the terms). */
export function statusParams(s: SimSeries): StatusParams {
  return statusParamsOf({ dueDays: s.terms.dueDays, graceDays: s.terms.graceDays, formalNoticeDays: s.terms.formalNoticeDays, hurdleWad: s.terms.hurdleWad });
}

/** Stage 1's `LedgerClock` for a series (SIM:340-352). Meaningful once the raise settled (`firstPeriod` is set then). */
export function ledgerClock(s: SimSeries): LedgerClock {
  const l = s.ledger;
  return {
    status: SeriesStatus[s.status],
    firstPeriod: l.firstPeriod ?? 0,
    lastAcceptedPeriod: l.lastAcceptedPeriod,
    openDuePeriod: l.openDuePeriod,
    openDueAmount: l.openDueAmount,
    pauses: l.pauses,
    trueupDue: l.trueupDue,
    trueupAttestedAt: l.trueupAttestedAt,
  };
}

/** The status at `now`: the stored status until the raise settles, then Stage 1's `deriveStatus` (SIM:364-367). */
export function derivedStatus(s: SimSeries, now: number): LifecycleStatus {
  if (s.phase !== 'Settled') return s.status;
  return SeriesStatus[deriveStatus(ledgerClock(s), BigInt(now), statusParams(s))] as LifecycleStatus;
}

/**
 * Stage 1's `mintFinalized` (the money gate, SPEC §6.1), the one source for the engine and the ledger and auction
 * views. Stage 1 sets it after the last `process_bid` of a settled raise, and of a failed one (SIM:978-984); our
 * settlement processes every bid in the same step, so a raise is mint-finalized exactly when it settled or failed. A
 * curve series is when it graduated (graduation settles it).
 */
export function mintFinalized(s: SimSeries): boolean {
  return s.phase === 'Settled' || s.phase === 'Failed';
}

/** `cap_per_unit()` read live from the (amendable) cap multiple and the clearing price (SIM:370-372); 0 before settlement. */
export function liveCapPerUnit(s: SimSeries): bigint {
  return s.issuePrice === null ? 0n : capPerUnit(s.terms.capMultipleWad, s.issuePrice);
}

/** `approve_pause` bounds (Stage 1 parameters, through DEFAULTS). */
export function pauseBounds(): PauseBounds {
  return { maxPauseSeconds: BigInt(DEFAULTS.maxPauseSeconds), maxCumulativePauseSeconds: BigInt(DEFAULTS.maxCumulativePauseSeconds), maxPauses: DEFAULTS.maxPauses };
}

// ------------------------------------------------------------------ stored status
/** Store a status and emit `StatusChanged` when it changes. */
export function setStatus(s: SimSeries, to: LifecycleStatus, emit: Emit): void {
  if (s.status === to) return;
  const from = s.status;
  s.status = to;
  emit('StatusChanged', { seriesId: s.seriesId, from, to });
}

/**
 * Retirement (SIM:445-454): the cap is met, nothing more is owed. Stores Retired (`StatusChanged`), emits
 * `SeriesRetired`, clears the open due and any true-up. A series already Retired is left as it is. `refund` is the
 * cap refund of the payment that retired the series (Stage 1 logs it; the canonical event has no field for it).
 */
export function retire(_e: EngineCore, s: SimSeries, _refund: bigint, _now: number, emit: Emit): void {
  if (s.status === 'Retired') return;
  setStatus(s, 'Retired', emit);
  const l = s.ledger;
  l.openDuePeriod = null;
  l.openDueAmount = 0n;
  l.trueupDue = 0n;
  l.trueupAttestedAt = 0n;
  emit('SeriesRetired', { seriesId: s.seriesId, paidPerUnitWad: s.vault.paidPerUnitWad.toString() });
}

/**
 * Where `syncStatus(e, s, now, emit)` must run, mirroring Stage 1's sync points exactly (`formalNoticeEmittedFor`
 * is part of the ledger view, so a missing or extra sync shows up in the vectors). Each owning work package places
 * its own call; nothing else may call it. Source: Stage 1 simulator lines.
 */
export const SYNC_POINTS = [
  { op: 'drawRelease (claim_release)', where: 'end, after the release', wp: 'WP4', sim: 1043 },
  { op: 'submitReport', where: 'end, after the report is recorded', wp: 'WP3', sim: 1148 },
  { op: 'payIn (non-tail)', where: 'end, after the vault receives it; never after a tail pay', wp: 'WP5', sim: 1184 },
  { op: 'approvePause', where: 'end, after the pause is recorded', wp: 'WP4', sim: 1296 },
  { op: 'crankStatus', where: 'the whole body (a no-op before settlement)', wp: 'WP4', sim: 645 },
  { op: 'redeem', where: 'after the quote, before the deposit', wp: 'WP6', sim: 1352 },
  { op: 'extinguish', where: 'before its mutations', wp: 'WP7', sim: 1433 },
  { op: 'openTransferWindow', where: 'after its checks', wp: 'WP8', sim: 1497 },
] as const;

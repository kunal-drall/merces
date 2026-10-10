import { DAY, pauseApprovalError, type Pause, type PauseBounds } from '@merces/math';
import { DEFAULTS } from './params.ts';
import type { SeriesPauses } from './state.ts';

/**
 * Stage 1's `approve_pause` bounds (SPEC §6.4, SIM:1284-1297) for every place that decides on a hardship pause: the
 * simulator's `approvePause` refuses with them, and the attestor service checks a decision with them before it records
 * an approval, so the offchain record never says "approved" for a pause the chain refuses (S1 review).
 */
export type PauseApprovalRule = 'InvalidPauseEnd' | 'AlreadyPaused' | 'PauseTooLong' | 'TooManyPauses';

/** Stage 1's pause parameters (`DEFAULT_PARAMETERS`, through DEFAULTS): one year per pause, two years in total, 16 pauses. */
export function pauseBounds(): PauseBounds {
  return { maxPauseSeconds: BigInt(DEFAULTS.maxPauseSeconds), maxCumulativePauseSeconds: BigInt(DEFAULTS.maxCumulativePauseSeconds), maxPauses: DEFAULTS.maxPauses };
}

const days = (s: number) => `${Math.floor(s / Number(DAY))} days`;

/** Value-free: each message names the rule and the protocol bound, never a submitted or recorded date. */
export const PAUSE_APPROVAL_MESSAGE: Readonly<Record<PauseApprovalRule, string>> = {
  InvalidPauseEnd: 'the pause end must be in the future',
  AlreadyPaused: 'a pause is already running',
  PauseTooLong: `a pause may last at most ${days(DEFAULTS.maxPauseSeconds)}, and the series' pauses ${days(DEFAULTS.maxCumulativePauseSeconds)} in total`,
  TooManyPauses: `the series has used all ${DEFAULTS.maxPauses} of its pauses`,
};

/**
 * Stage 1's `pauseApprovalError` for approving, at `now`, a pause that ends at `until`, over the chain's pause record
 * (`SeriesState.pauses`): null when `approve_pause` would accept it, otherwise Stage 1's error name.
 *
 * `pauseApprovalError` reads three things from the pauses: whether one runs at `now`, how many were approved, and the
 * sum of their lengths. The read carries all three (`current`, `count`, `pausedTotalSeconds`), so the record is passed
 * as the running pause, if any, plus one ended placeholder for each other approved pause.
 */
export function pauseApprovalRefusal(view: Pick<SeriesPauses, 'count' | 'pausedTotalSeconds' | 'current'>, now: number, until: number, bounds: PauseBounds = pauseBounds()): PauseApprovalRule | null {
  const pauses: Pause[] = [];
  if (view.current) pauses.push({ start: BigInt(view.current.start), end: BigInt(view.current.end) });
  while (pauses.length < view.count) pauses.push({ start: 0n, end: 0n });
  return pauseApprovalError(pauses, BigInt(view.pausedTotalSeconds), BigInt(now), BigInt(until), bounds);
}

/**
 * Whether no pause at all could be approved at `now`: the series has used all its pauses, or its cumulative limit
 * leaves no time (Stage 1's rules on the shortest pause, one second). A running pause is not counted here.
 */
export function noPauseApprovable(view: Pick<SeriesPauses, 'count' | 'pausedTotalSeconds' | 'current'>, now: number, bounds: PauseBounds = pauseBounds()): 'PauseTooLong' | 'TooManyPauses' | null {
  const r = pauseApprovalRefusal({ ...view, current: null }, now, now + 1, bounds);
  return r === 'PauseTooLong' || r === 'TooManyPauses' ? r : null;
}

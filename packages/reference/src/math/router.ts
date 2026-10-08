/**
 * Tier-1 split router (SPEC v1.1 §6.5, brief D5) with period checkpoints for the tier-1 report
 * binding `Poseidon(2)(ytd_at_end[period], 0)`.
 */
import { WAD, mulDiv, periodOf, yearOf } from "@merces/sdk";

export interface RouterCheckpoint {
  period: number;
  ytdAtEnd: bigint;
}

export const ROUTER_CHECKPOINT_RING = 8;

export interface RouterState {
  theta: bigint;
  rWad: bigint;
  ytdYear: number;
  ytdReceived: bigint;
  /** receipts that arrived before mint finalization, routed afterwards */
  heldBeforeFinalization: bigint;
  /** the next period that still needs a checkpoint (the router's first period at activation) */
  nextCheckpointPeriod: number;
  /** ring of the last 8 checkpoints */
  checkpoints: RouterCheckpoint[];
}

export function newRouterState(theta: bigint, rWad: bigint, firstPeriod: number): RouterState {
  return { theta, rWad, ytdYear: yearOf(firstPeriod), ytdReceived: 0n, heldBeforeFinalization: 0n, nextCheckpointPeriod: firstPeriod, checkpoints: [] };
}

/**
 * Records a checkpoint for every period from `nextCheckpointPeriod` through `lastPeriod`
 * (inclusive). The YTD figure resets to 0 at a year boundary, so a Q4 checkpoint holds the year
 * total and later periods of a new year without receipts hold 0.
 */
export function closePeriodsThrough(state: RouterState, lastPeriod: number): RouterState {
  if (lastPeriod < state.nextCheckpointPeriod) return state;
  const checkpoints = [...state.checkpoints];
  for (let p = state.nextCheckpointPeriod; p <= lastPeriod; p++) {
    checkpoints.push({ period: p, ytdAtEnd: yearOf(p) === state.ytdYear ? state.ytdReceived : 0n });
    while (checkpoints.length > ROUTER_CHECKPOINT_RING) checkpoints.shift();
  }
  return { ...state, checkpoints, nextCheckpointPeriod: lastPeriod + 1 };
}

/** `close_router_period(series, period)`: requires `now ≥ period_end(period)` (checked by the caller). */
export function closeRouterPeriod(state: RouterState, period: number): RouterState {
  return closePeriodsThrough(state, period);
}

/** `ytd_at_end[period]`, or null when the checkpoint is missing (`RouterPeriodNotClosed`). */
export function ytdAtEnd(state: RouterState, period: number): bigint | null {
  const cp = state.checkpoints.find((c) => c.period === period);
  return cp ? cp.ytdAtEnd : null;
}

export interface RouteResult {
  passThrough: bigint;
  /** gross amount sent to the vault before cap truncation */
  share: bigint;
  state: RouterState;
}

/** `route(series, amount)` at time `now` with `units_outstanding` (SPEC §6.5). */
export function routeIncome(state: RouterState, amount: bigint, unitsOutstanding: bigint, now: bigint): RouteResult {
  if (amount < 0n) throw new RangeError("negative amount");
  const periodNow = periodOf(now);
  let s = closePeriodsThrough(state, periodNow - 1);
  const yearNow = yearOf(periodNow);
  if (yearNow !== s.ytdYear) s = { ...s, ytdYear: yearNow, ytdReceived: 0n };
  const below = s.theta > s.ytdReceived ? s.theta - s.ytdReceived : 0n;
  const passA = amount < below ? amount : below;
  const above = amount - passA;
  let share = mulDiv(above, s.rWad * unitsOutstanding, WAD);
  if (share > above) share = above;
  return { passThrough: amount - share, share, state: { ...s, ytdReceived: s.ytdReceived + amount } };
}

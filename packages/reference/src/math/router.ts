/**
 * Tier-1 split router (SPEC §6.5, brief D5).
 */
import { WAD, mulDiv } from "@merces/sdk";

export interface RouterState {
  theta: bigint;
  rWad: bigint;
  ytdYear: number;
  ytdReceived: bigint;
}

export interface RouteResult {
  passThrough: bigint;
  /** gross amount sent to the vault before cap truncation */
  share: bigint;
  state: RouterState;
}

export function routeIncome(state: RouterState, amount: bigint, unitsOutstanding: bigint, yearNow: number): RouteResult {
  if (amount < 0n) throw new RangeError("negative amount");
  let s = state;
  if (yearNow !== s.ytdYear) s = { ...s, ytdYear: yearNow, ytdReceived: 0n };
  const below = s.theta > s.ytdReceived ? s.theta - s.ytdReceived : 0n;
  const passA = amount < below ? amount : below;
  const above = amount - passA;
  let share = mulDiv(s.rWad * unitsOutstanding, above, WAD);
  if (share > above) share = above;
  return { passThrough: amount - share, share, state: { ...s, ytdReceived: s.ytdReceived + amount } };
}

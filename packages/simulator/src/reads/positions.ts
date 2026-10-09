import type { PositionState } from '@merces/domain';
import { claimable } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toPosition(x: SimSeries, p: SimPosition): PositionState {
  const tail = x.redemption && p.redeemedUnits > 0n ? claimable(p.redeemedUnits, x.redemption.accTailNetWad, p.tailDebt) : 0n;
  return { seriesId: x.seriesId, wallet: p.wallet, units: s(p.units), rewardDebt: s(p.rewardDebt), claimable: s(claimable(p.units, x.accNetWad, p.rewardDebt) + p.pending), claimedTotal: s(p.claimedTotal), redeemedUnits: s(p.redeemedUnits), tailClaimable: s(tail) };
}
/** The positions a series lists: holders, and past holders with something left to claim. */
export function listPositionStates(x: SimSeries): PositionState[] {
  return [...x.positions.values()].filter((p) => p.units > 0n || p.pending > 0n || p.redeemedUnits > 0n).map((p) => toPosition(x, p));
}

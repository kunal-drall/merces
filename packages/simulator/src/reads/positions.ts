import type { PositionState } from '@merces/domain';
import { interim } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { claimableTail } from '../engine/redemption.ts';
import { claimableFinal } from '../engine/terminal.ts';

/** `claimable` is the net payout only; the tail and the final pool are separate fields (claimPayout pays all three). */
export function toPosition(x: SimSeries, p: SimPosition): PositionState {
  return {
    seriesId: x.seriesId, wallet: p.wallet, units: s(p.units), claimable: s(interim.claimable(p.units, x.accNetWad, p.rewardDebt) + p.pending), claimedTotal: s(p.claimedTotal), redeemedUnits: s(p.redeemedUnits),
    tailClaimable: s(claimableTail(x, p)), finalClaimable: s(claimableFinal(x, p)), registered: p.registered, pending: s(p.pending), lastAccWad: s(p.lastNetAccWad),
  };
}
/** The positions a series lists: holders, and past holders with something left to claim. */
export function listPositionStates(x: SimSeries): PositionState[] {
  return [...x.positions.values()].filter((p) => p.units > 0n || p.pending > 0n || p.redeemedUnits > 0n).map((p) => toPosition(x, p));
}

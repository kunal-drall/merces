import type { PositionState } from '@merces/domain';
import type { SimPosition, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { claimableNet, undeliveredUnits } from '../engine/holders.ts';
import { claimableTail } from '../engine/redemption.ts';
import { claimableFinal } from '../engine/terminal.ts';

/**
 * A holder's position. `units` is its accrual weight, its auction units not yet delivered included
 * (`undeliveredUnits`). `claimable` is the net payout only (`pending` plus what accrued since the holder's vault
 * cursor); the tail and the final pool are the separate `tailClaimable` and `finalClaimable` (amendment M9: nothing
 * is counted twice). One `claimPayout` pays all three.
 */
export function toPosition(x: SimSeries, p: SimPosition): PositionState {
  return {
    seriesId: x.seriesId, wallet: p.wallet, units: s(p.units), undeliveredUnits: s(undeliveredUnits(x, p.wallet)), claimable: s(claimableNet(x, p)), claimedTotal: s(p.claimedTotal), redeemedUnits: s(p.redeemedUnits),
    tailClaimable: s(claimableTail(x, p)), finalClaimable: s(claimableFinal(x, p)), registered: p.registered, pending: s(p.pending), lastAccWad: s(p.lastNetAccWad),
  };
}
/** The positions a series lists: holders, and past holders with something left to claim. */
export function listPositionStates(x: SimSeries): PositionState[] {
  return [...x.positions.values()].filter((p) => p.units > 0n || p.pending > 0n || p.redeemedUnits > 0n).map((p) => toPosition(x, p));
}

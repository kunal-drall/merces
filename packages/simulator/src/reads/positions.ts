import type { PositionState } from '@merces/domain';
import { scaledAmount } from '@merces/math';
import type { SimPosition, SimSeries, SimState } from '../state.ts';
import { balKey, str as s } from '../engine/core.ts';
import { accrualUnits, blankPosition, claimableNet, heldUnits, undeliveredUnits } from '../engine/holders.ts';
import { claimableRedemption, claimableTail } from '../engine/redemption.ts';
import { tenderQuotaLeft } from '../engine/stake.ts';
import { claimableFinal } from '../engine/terminal.ts';

/** A curve wallet's base lamports of the series' unit mint (0 on a sealed-bid series). */
function curveWalletUnits(state: SimState, x: SimSeries, wallet: string): bigint {
  return x.curve ? state.balances.get(balKey(wallet, x.curve.baseMint)) ?? 0n : 0n;
}

/**
 * What a tender would pay as principal now (Stage 1 `tender_units`, no tail catch-up): the holder's whole stake (always
 * reserved) and the wallet units that fit what is left of the tender quota, at `floor(P_redeem × units / 10^6)`; 0 before
 * a redemption.
 */
function tenderPreview(x: SimSeries, p: SimPosition, walletUnits: bigint): bigint {
  if (!x.redemption) return 0n;
  const quota = tenderQuotaLeft(x);
  const fromWallet = walletUnits < quota ? walletUnits : quota;
  return scaledAmount(x.redemption.pricePerUnit, p.stakedUnits + fromWallet, x.unitScale);
}

/**
 * A holder's position. `units` is its accrual weight, its auction units not yet delivered included
 * (`undeliveredUnits`); on a curve series its stake (only staked units earn), with the units in its wallet in
 * `walletUnits`. Each claimable amount is what one claim of Stage 1's family pays (nothing is counted twice):
 * `claimable` the net payout (`pending` plus what accrued since the holder's vault cursor; on a curve series that did not
 * redeem, an extinguishment's final share of its stake too), `claimPayout`; `redemptionClaimable` the redemption
 * principal and tail catch-up, `claimRedemption` (a curve's: the principal a tender of its stake and the wallet units
 * that fit the quota would pay, `tenderUnits`); `tailClaimable` the tail, `claimTail`; `finalClaimable` the final-pool
 * share, `claimFinal`.
 */
export function toPosition(state: SimState, x: SimSeries, p: SimPosition): PositionState {
  const walletUnits = x.curve ? curveWalletUnits(state, x, p.wallet) : heldUnits(x, p);
  return {
    seriesId: x.seriesId, wallet: p.wallet, units: s(accrualUnits(x, p)), stakedUnits: s(p.stakedUnits), walletUnits: s(walletUnits),
    undeliveredUnits: s(undeliveredUnits(x, p.wallet)), escrowedUnits: s(p.escrowed), claimable: s(claimableNet(x, p)), claimedTotal: s(p.claimedTotal), redeemedUnits: s(p.redeemedUnits),
    redemptionClaimable: s(x.curve ? tenderPreview(x, p, walletUnits) : claimableRedemption(x, p)), tailClaimable: s(claimableTail(x, p)), finalClaimable: s(claimableFinal(x, p)),
    registered: p.registered, pending: s(p.pending), lastAccWad: s(p.lastNetAccWad),
  };
}

/**
 * A wallet's position in a series, or null when it has none. On a curve series a wallet that holds units without a
 * holder record (it bought and never registered) reads as an unregistered position with its `walletUnits` (a blank
 * record is read, never stored).
 */
export function getPositionState(state: SimState, x: SimSeries, wallet: string): PositionState | null {
  const p = x.positions.get(wallet);
  if (p) return toPosition(state, x, p);
  if (x.curve && curveWalletUnits(state, x, wallet) > 0n) return toPosition(state, x, blankPosition(wallet));
  return null;
}

/**
 * The positions a series lists: holders, and past holders with something left to claim. On a curve series its
 * registered holders (stakers among them): units in wallets that never registered are not listed.
 */
export function listPositionStates(state: SimState, x: SimSeries): PositionState[] {
  const listed = (p: SimPosition): boolean => (x.curve ? p.registered : p.units > 0n || p.pending > 0n || p.redeemedUnits > 0n);
  return [...x.positions.values()].filter(listed).map((p) => toPosition(state, x, p));
}

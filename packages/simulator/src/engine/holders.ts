import { interim } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { str, type Emit } from './core.ts';

export function position(s: SimSeries, wallet: string): SimPosition {
  let p = s.positions.get(wallet);
  if (!p) {
    p = { wallet, units: 0n, escrowed: 0n, rewardDebt: 0n, pending: 0n, claimedTotal: 0n, redeemedUnits: 0n, tailDebt: 0n, redemptionClaimed: false };
    s.positions.set(wallet, p);
  }
  return p;
}
/** Settle accrued payouts into `pending` before a unit change, then re-base the debt. */
export function settlePosition(s: SimSeries, p: SimPosition): void {
  p.pending += interim.claimable(p.units, s.accNetWad, p.rewardDebt);
  p.rewardDebt = interim.rewardDebt(p.units, s.accNetWad);
}
export function setUnits(s: SimSeries, p: SimPosition, units: bigint): void {
  settlePosition(s, p);
  p.units = units;
  p.rewardDebt = interim.rewardDebt(units, s.accNetWad);
}
/** The units a holder's payouts accrue on. Today every unit, escrowed ones included. */
export function accrualUnits(_s: SimSeries, p: SimPosition): bigint {
  return p.units;
}
export function burn(s: SimSeries, p: SimPosition, reason: 'cap' | 'redemption' | 'extinguishment', emit: Emit): void {
  const units = p.units;
  if (units === 0n) return;
  setUnits(s, p, 0n);
  s.unitsOutstanding -= units;
  emit('UnitsBurned', { seriesId: s.seriesId, holder: p.wallet, units: str(units), reason });
}

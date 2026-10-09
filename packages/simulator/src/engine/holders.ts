import { interim } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { str, type EngineCore, type Emit } from './core.ts';

export function position(s: SimSeries, wallet: string): SimPosition {
  let p = s.positions.get(wallet);
  if (!p) {
    p = { wallet, units: 0n, escrowed: 0n, rewardDebt: 0n, pending: 0n, claimedTotal: 0n, redeemedUnits: 0n, tailDebt: 0n, redemptionClaimed: false, registered: false, lastNetAccWad: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false };
    s.positions.set(wallet, p);
  }
  return p;
}
/**
 * Stage 1 `registerHolder` (SIM:406-416): idempotent. Sets the net cursor to the live `vault.netAccWad`; the tail and
 * final cursors start at 0, so a holder registered after a redemption or extinguishment still gets its full slice.
 * Runs where Stage 1 registers holders: auction allocation, curve graduation, a window buy fill.
 */
export function registerHolder(s: SimSeries, p: SimPosition): void {
  if (p.registered) return;
  p.registered = true;
  p.lastNetAccWad = s.vault.netAccWad;
  p.lastTailAccWad = 0n;
  p.lastFinalAccWad = 0n;
}
/** Settle accrued payouts into `pending` before a unit change, then re-base the debt. */
export function settlePosition(s: SimSeries, p: SimPosition): void {
  p.pending += interim.claimable(p.units, s.accNetWad, p.rewardDebt);
  p.rewardDebt = interim.rewardDebt(p.units, s.accNetWad);
}
/**
 * Stage 1 `settleHolder` (SIM:430-436), the cross-module contract: fold the holder's accrued payout into `pending` and
 * move its cursor. Today it settles the interim accumulator (`settlePosition`); WP5 moves it to `vault.netAccWad` and
 * the `lastNetAccWad` cursor, with HolderNotRegistered for an unregistered holder.
 */
export function settleHolder(_e: EngineCore, s: SimSeries, p: SimPosition): void {
  settlePosition(s, p);
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

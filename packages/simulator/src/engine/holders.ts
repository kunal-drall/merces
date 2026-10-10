import { ChainError } from '@merces/domain';
import { settleHolderDelta } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { str, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';

/**
 * Holders on Stage 1's payout cursors (SPEC v1.1 §6.1, §6.3; Stage 1 simulator SIM:399-443).
 *
 * A registered holder's payout accrues as `floor((vault.netAccWad − lastNetAccWad) × accrualUnits / WAD)`
 * (`settleHolderDelta`); settling folds it into `pending` and moves the cursor. Payouts accrue to registered holders
 * only: registration (auction allocation, curve graduation, a window buy fill) sets the cursor to the live
 * accumulator, so nothing paid before it counts.
 */

export function position(s: SimSeries, wallet: string): SimPosition {
  let p = s.positions.get(wallet);
  if (!p) {
    p = { wallet, units: 0n, escrowed: 0n, pending: 0n, claimedTotal: 0n, redeemedUnits: 0n, registered: false, lastNetAccWad: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false };
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
/**
 * The units a holder's payouts accrue on (Stage 1 `accrual_units`, SPEC §6.1: balance + undelivered auction units +
 * ask-escrow units). Our raise delivers at settlement and window asks keep their units in `units` (`escrowed` marks
 * them), so it is `units`.
 */
export function accrualUnits(_s: SimSeries, p: SimPosition): bigint {
  return p.units;
}
/** The payout a registered holder accrued since its last settlement (0 for an unregistered one); moves nothing. */
function accruedSince(s: SimSeries, p: SimPosition): bigint {
  return p.registered ? settleHolderDelta(s.vault.netAccWad, p.lastNetAccWad, accrualUnits(s, p)) : 0n;
}
/** Fold a registered holder's accrual into `pending` and move its cursor; an unregistered holder accrues nothing. */
function settleAccrual(s: SimSeries, p: SimPosition): void {
  if (!p.registered) return;
  p.pending += accruedSince(s, p);
  p.lastNetAccWad = s.vault.netAccWad;
}
/**
 * Stage 1 `settleHolder` (SIM:430-436), the cross-module contract: fold the holder's accrued payout into `pending` and
 * move its cursor. An unregistered holder is refused (HolderNotRegistered).
 */
export function settleHolder(_e: EngineCore, s: SimSeries, p: SimPosition): void {
  if (!p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleAccrual(s, p);
}
/** The net payout a holder could claim now: `pending` plus what accrued since its cursor (the read side of a claim). */
export function claimableNet(s: SimSeries, p: SimPosition): bigint {
  return p.pending + accruedSince(s, p);
}
/** Change a holder's units, settling its accrual first (a registered holder only) so nothing is lost or re-earned. */
export function setUnits(s: SimSeries, p: SimPosition, units: bigint): void {
  settleAccrual(s, p);
  p.units = units;
}
/**
 * Burn `units` of a holder's units (Stage 1 `burn`, SIM:438-443): settle, reduce its units and `unitsOutstanding`,
 * `UnitsBurned`. Zero is a no-op. Every caller burns the holder's balance, the units not held for a window ask (Stage 1
 * `unitsOf` excludes the ask escrow): the redemption body, the final claim and the Retired burns.
 */
export function burnUnits(s: SimSeries, p: SimPosition, units: bigint, reason: 'cap' | 'redemption' | 'extinguishment', emit: Emit): void {
  if (units === 0n) return;
  if (units < 0n || units > p.units) throw new ChainError('ChainSpecific', 'burn exceeds the holder units'); // never happens: callers burn what the holder has
  setUnits(s, p, p.units - units);
  s.unitsOutstanding -= units;
  emit('UnitsBurned', { seriesId: s.seriesId, holder: p.wallet, units: str(units), reason });
}

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
 * only: registration (auction allocation, a window buy fill, or `registerHolder`, the only way on a curve series) sets
 * the cursor to the live accumulator, so nothing paid before it counts.
 */

/** A holder record before anything happened to it (not stored). */
export function blankPosition(wallet: string): SimPosition {
  return { wallet, units: 0n, escrowed: 0n, pending: 0n, claimedTotal: 0n, redeemedUnits: 0n, registered: false, lastNetAccWad: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false, stakedUnits: 0n };
}

/** `wallet`'s holder record in the series, created (blank) when it has none. */
export function position(s: SimSeries, wallet: string): SimPosition {
  let p = s.positions.get(wallet);
  if (!p) {
    p = blankPosition(wallet);
    s.positions.set(wallet, p);
  }
  return p;
}
/**
 * Stage 1 `registerHolder` (SIM:406-416): idempotent. Sets the net cursor to the live `vault.netAccWad`; the tail and
 * final cursors start at 0, so a holder registered after a redemption or extinguishment still gets its full slice.
 * The first registration emits `HolderRegistered` (as both chains do): the `registerHolder` command, a winning
 * `processBid` and a window buy fill. A curve series registers a holder only through `registerHolder` (Stage 1: an
 * allowlisted wallet; its completion registers nobody).
 */
export function registerHolder(s: SimSeries, p: SimPosition, emit: Emit): void {
  if (p.registered) return;
  p.registered = true;
  p.lastNetAccWad = s.vault.netAccWad;
  p.lastTailAccWad = 0n;
  p.lastFinalAccWad = 0n;
  emit('HolderRegistered', { seriesId: s.seriesId, holder: p.wallet });
}
/** Auction units allocated to `wallet` and not yet delivered (Stage 1 `pending_units` of a processed, undelivered bid). */
export function undeliveredUnits(s: SimSeries, wallet: string): bigint {
  const b = s.bids.get(wallet);
  return b && b.processed && !b.delivered ? b.pendingUnits : 0n;
}
/**
 * The units a holder's account holds (Stage 1 `unitsOf`): its units less those held for a window ask and those
 * allocated but not yet delivered. What a window ask may escrow and what a Retired burn burns.
 */
export function windowPendingUnits(s: SimSeries, wallet: string): bigint {
  return s.transferWindows.reduce((sum, w) => { const o = w.orders.get(wallet); return sum + (o?.processed && !o.delivered ? o.pendingUnits : 0n); }, 0n);
}
export function requireWindowDelivery(s: SimSeries, wallet: string): void {
  if (windowPendingUnits(s, wallet) > 0n) fail('DeliverFirst');
}
export function heldUnits(s: SimSeries, p: SimPosition): bigint {
  return p.units - p.escrowed - undeliveredUnits(s, p.wallet) - windowPendingUnits(s, p.wallet);
}
/**
 * The units a holder's payouts accrue on (Stage 1 `accrual_units`, SPEC §6.1: balance + undelivered auction units +
 * ask-escrow units). `units` holds all three: a processed winner's units join it at `processBid` (delivery moves
 * none), and a window ask keeps its units there (`escrowed` marks them). On a curve series only staked units earn
 * (Stage 1 `settle_curve_holder`, curve.rs:516-535): the holder's `stakedUnits`; units in its wallet earn nothing.
 */
export function accrualUnits(s: SimSeries, p: SimPosition): bigint {
  return s.curve ? p.stakedUnits : p.units;
}
/**
 * The payout a registered holder accrued since its last settlement (0 for an unregistered one); moves nothing. On a curve
 * series (Stage 1 `settle_curve_holder`, curve.rs:516-535) it is weighed on the holder's stake, and while the series has
 * not redeemed it also takes the stake's share of the final pool since the holder's final cursor (0 until an
 * extinguishment distributes one): an extinguished curve's final share is paid as part of the pending payout.
 */
function accruedSince(s: SimSeries, p: SimPosition): bigint {
  if (!p.registered) return 0n;
  const w = accrualUnits(s, p);
  let net = settleHolderDelta(s.vault.netAccWad, p.lastNetAccWad, w);
  // C-S4: ask escrow earns only up to clearing; sold units earn for buyers from that accumulator onward.
  if (!s.curve && p.escrowed > 0n) {
    const cleared = s.transferWindows.find((x) => x.clearing && x.orders.get(p.wallet)?.side === 'sell' && !x.orders.get(p.wallet)!.processed);
    if (cleared) {
      const base = w - p.escrowed, snap = cleared.accAtClear;
      net = p.lastNetAccWad < snap
        ? settleHolderDelta(snap, p.lastNetAccWad, w) + settleHolderDelta(s.vault.netAccWad, snap, base)
        : settleHolderDelta(s.vault.netAccWad, p.lastNetAccWad, base);
    }
  }
  return curveTakesFinal(s) ? net + settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, w) : net;
}
/** Curve mode settles the final pool into `pending` while the series has not redeemed (Stage 1 `redemption_ts == 0`). */
function curveTakesFinal(s: SimSeries): boolean {
  return s.curve !== null && s.redemption === null;
}
/**
 * Fold a registered holder's accrual into `pending` and move its cursor (on a curve series that has not redeemed, its
 * final cursor too); an unregistered holder accrues nothing.
 */
function settleAccrual(s: SimSeries, p: SimPosition): void {
  if (!p.registered) return;
  p.pending += accruedSince(s, p);
  p.lastNetAccWad = s.vault.netAccWad;
  if (curveTakesFinal(s)) p.lastFinalAccWad = s.final.finalAccWad;
}
/**
 * Stage 1 `settleHolder` (SIM:430-436), the cross-module contract: fold the holder's accrued payout into `pending` and
 * move its cursor. An unregistered holder is refused (HolderNotRegistered). On a curve series it is Stage 1's
 * `settle_curve_holder` (curve.rs:516-535), which every stake, unstake, tender and claim runs first.
 */
export function settleHolder(_e: EngineCore, s: SimSeries, p: SimPosition): void {
  if (!p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleAccrual(s, p);
}
/**
 * The net payout a holder could claim now: `pending` plus what accrued since its cursor (the read side of a claim; on a
 * curve series that has not redeemed, an extinguishment's final share included, as `claimPayout` pays it).
 */
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

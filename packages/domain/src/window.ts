import { findWindowClearingPrice, type WindowOrder } from '@merces/math';
import type { PermissionlessCommand } from './commands.ts';
import type { ChainLimits, TransferWindowState } from './state.ts';

/** Next bounded permissionless step from a fresh chain read. Recompute after every transaction. */
export function nextWindowStep(w: TransferWindowState, now: number, limits: ChainLimits): PermissionlessCommand | null {
  const base = { seriesId: w.seriesId, windowId: w.windowId };
  if ((w.state === 'Commit' || w.state === 'Reveal') && now < w.revealEndsAt) return null;
  if (w.state === 'Commit' || w.state === 'Reveal' || (w.state === 'Settling' && w.roundRejected)) {
    const orders: WindowOrder[] = w.orders.map((o) => ({ owner: o.owner, side: o.side === 'buy' ? 0 : 1, escrow: BigInt(o.escrow), revealed: o.revealed, valid: o.valid, price: BigInt(o.pricePerUnit ?? '0'), quantity: BigInt(o.quantity ?? '0'), revealIndex: o.revealIndex }));
    return { kind: 'beginWindowSettlement', ...base, clearingPrice: findWindowClearingPrice(orders)?.toString() ?? null };
  }
  if (w.state === 'Settling') {
    if (w.talliedCount < w.orders.filter((o) => o.revealed).length) return { kind: 'tallyWindow', ...base, maxOrders: limits.tallyPageMax };
    return { kind: 'finalizeWindow', ...base };
  }
  if (w.state === 'Settled' || w.state === 'NoMatch') {
    const next = w.orders.filter((o) => !o.processed).sort((a, b) => a.side === b.side ? a.revealIndex - b.revealIndex : a.side === 'buy' ? -1 : 1)[0];
    if (next) return { kind: 'processOrder', ...base, owner: next.owner };
  }
  return null;
}
/** Delivery stays available independently of status, feature flags and later windows. */
export function windowDeliveries(w: TransferWindowState): Extract<PermissionlessCommand, {kind:'deliverOrder'}>[] {
  return w.orders.filter((o) => o.processed && !o.delivered).map((o) => ({ kind: 'deliverOrder', seriesId: w.seriesId, windowId: w.windowId, owner: o.owner }));
}

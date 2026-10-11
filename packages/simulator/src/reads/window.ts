import { fromPid } from '@merces/math';
import type { TransferWindowState } from '@merces/domain';
import type { SimTransferWindow } from '../state.ts';
import { str as s } from '../engine/core.ts';

/**
 * A window's escrow totals (Stage 1 `escrow_stable` / `escrow_units`, SPEC v1.1 §7): the buy deposits not yet paid out
 * or refunded, and the units held for asks. Both are 0 once the window clears. The one source for the window view and
 * the vector `expect` money view (`stage1-view.ts`).
 */
export function windowEscrow(w: SimTransferWindow): { stable: bigint; units: bigint } {
  return { stable: w.escrowStable, units: w.escrowUnits };
}

export function toTransferWindow(seriesId: string, w: SimTransferWindow): TransferWindowState {
  const escrow = windowEscrow(w);
  return {
    seriesId,
    periodId: fromPid(w.period), state: w.state, tallyRound: w.tallyRound, roundRejected: w.roundRejected,
    proposal: w.proposal?.toString() ?? null, talliedCount: w.talliedCount, branch: w.clearing?.branch ?? null,
    matchedUnits: s(w.clearing?.matchedUnits ?? 0n), accAtClear: s(w.accAtClear),
    orders: [...w.orders.values()].map((o) => ({ owner: o.wallet, side: o.side, commitment: o.commitment,
      escrow: s(o.side === 'buy' ? o.deposit : o.escrowedUnits), revealed: o.revealed !== null, valid: o.valid,
      pricePerUnit: o.revealed?.pricePerUnit.toString() ?? null, quantity: o.revealed?.quantity.toString() ?? null,
      revealIndex: o.revealIndex, talliedRound: o.talliedRound, processed: o.processed, delivered: o.delivered,
      fill: s(o.fill), pendingUnits: s(o.pendingUnits), pendingStable: s(o.pendingStable), cancelled: o.cancelled })),
    windowId: w.windowId,
    commitEndsAt: w.commitEndsAt,
    revealEndsAt: w.revealEndsAt,
    cleared: w.cleared,
    clearingPrice: w.clearingPrice === null ? null : s(w.clearingPrice),
    orderCount: w.orders.size,
    escrowStable: s(escrow.stable),
    escrowUnits: s(escrow.units),
  };
}

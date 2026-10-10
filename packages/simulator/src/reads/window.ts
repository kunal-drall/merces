import type { TransferWindowState } from '@merces/domain';
import type { SimTransferWindow } from '../state.ts';
import { str as s } from '../engine/core.ts';

/**
 * A window's escrow totals (Stage 1 `escrow_stable` / `escrow_units`, SPEC v1.1 §7): the buy deposits not yet paid out
 * or refunded, and the units held for asks. Both are 0 once the window clears. The one source for the window view and
 * the vector `expect` money view (`stage1-view.ts`).
 */
export function windowEscrow(w: SimTransferWindow): { stable: bigint; units: bigint } {
  let stable = 0n;
  let units = 0n;
  for (const o of w.orders.values()) {
    if (o.side === 'buy') stable += o.deposit;
    else units += o.escrowedUnits;
  }
  return { stable, units };
}

export function toTransferWindow(seriesId: string, w: SimTransferWindow): TransferWindowState {
  const escrow = windowEscrow(w);
  return {
    seriesId,
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

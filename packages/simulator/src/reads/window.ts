import type { TransferWindowState } from '@merces/domain';
import type { SimTransferWindow } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toTransferWindow(seriesId: string, w: SimTransferWindow): TransferWindowState {
  return { seriesId, windowId: w.windowId, commitEndsAt: w.commitEndsAt, revealEndsAt: w.revealEndsAt, cleared: w.cleared, clearingPrice: w.clearingPrice === null ? null : s(w.clearingPrice), orderCount: w.orders.size };
}

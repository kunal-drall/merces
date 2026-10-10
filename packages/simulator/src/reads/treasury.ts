import type { TreasuryState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { releasesBlockedByLateness } from '../engine/status.ts';

/**
 * The treasury: `paused` is the issuer's own pause or the live lateness block (derived Late, or late underneath a
 * hardship pause: Stage 1 `is_late_underlying`); `balance` is what it still holds (released and returned excluded): after
 * an extinguishment, the tranches vested by then, until the issuer draws them.
 */
export function toTreasuryState(seriesId: string, x: SimSeries, now: number): TreasuryState {
  return {
    seriesId, total: s(x.treasuryTotal), released: s(x.treasuryReleased), balance: s(x.treasuryTotal - x.treasuryReleased - x.treasuryReturned),
    paused: x.releasesPausedByIssuer || releasesBlockedByLateness(x, now),
    // a tranche returned to holders at an extinguishment (it had not vested) is never drawable: no `drawableAt`
    tranches: x.tranches.map((t) => ({ index: t.index, afterSeconds: t.afterSeconds, bps: t.bps, amount: s(t.amount), drawableAt: x.settledAt === null || t.returned ? null : x.settledAt + t.afterSeconds, drawn: t.drawn })),
  };
}

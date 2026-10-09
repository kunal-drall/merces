import type { TreasuryState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toTreasuryState(seriesId: string, x: SimSeries): TreasuryState {
  return {
    seriesId, total: s(x.treasuryTotal), released: s(x.treasuryReleased), balance: s(x.treasuryTotal - x.treasuryReleased), paused: x.releasesPausedLate || x.releasesPausedByIssuer,
    tranches: x.tranches.map((t) => ({ index: t.index, afterSeconds: t.afterSeconds, bps: t.bps, amount: s(t.amount), drawableAt: x.settledAt === null ? null : x.settledAt + t.afterSeconds, drawn: t.drawn })),
  };
}

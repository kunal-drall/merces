import type { CurveState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toCurveState(seriesId: string, x: SimSeries): CurveState {
  const c = x.curve!;
  const spot = c.basePrice + (c.basePrice * c.slopeWad * x.unitsOutstanding) / 10n ** 18n;
  return { seriesId, quoteStablecoin: c.quoteStablecoin, raised: s(c.raised), unitsOutstanding: s(x.unitsOutstanding), spotPrice: s(spot), graduationThreshold: s(c.graduationThreshold), graduated: c.graduated };
}

import type { RedemptionState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { tailPaidPerUnit } from '../engine/redemption.ts';

/**
 * A series' redemption: the price, units and deposit fixed at `redeem`, the principal claimed so far, and the tail
 * from Stage 1's tail state (`SimSeries.tail`): cap, per-unit paid (WAD), accumulator, exhaustion and the refunds.
 * `tailPaidPerUnit` (deprecated) is the WAD figure in base units per whole unit (at the series' unit scale).
 */
export function toRedemption(x: SimSeries): RedemptionState {
  const r = x.redemption!;
  return {
    openedAt: r.openedAt, pricePerUnit: s(r.pricePerUnit), unitsAtRedemption: s(r.unitsAtRedemption), deposit: s(r.deposit), claimed: s(r.claimed), tailCapPerUnit: s(x.tail.tailCapPerUnit), tailEndsAt: r.tailEndsAt,
    tailPaidPerUnit: s(tailPaidPerUnit(x)), tailPaidPerUnitWad: s(x.tail.tailPaidPerUnitWad), tailAccWad: s(x.tail.tailAccWad), tailExhausted: x.tail.tailExhausted, tailRefunded: s(x.tail.tailRefunded),
  };
}

import type { RedemptionState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toRedemption(x: SimSeries): RedemptionState {
  const r = x.redemption!;
  return {
    openedAt: r.openedAt, pricePerUnit: s(r.pricePerUnit), unitsAtRedemption: s(r.unitsAtRedemption), deposit: s(r.deposit), claimed: s(r.claimed), tailCapPerUnit: s(r.tailCapPerUnit), tailEndsAt: r.tailEndsAt, tailPaidPerUnit: s(r.tailPaidPerUnit),
    tailPaidPerUnitWad: s(x.tail.tailPaidPerUnitWad), tailAccWad: s(x.tail.tailAccWad), tailExhausted: x.tail.tailExhausted, tailRefunded: s(x.tail.tailRefunded),
  };
}

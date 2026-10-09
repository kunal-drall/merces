import type { VaultState } from '@merces/domain';
import { claimable } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';

export function toVaultState(seriesId: string, x: SimSeries): VaultState {
  const entitled = [...x.positions.values()].reduce((a, p) => a + claimable(p.units, x.accNetWad, p.rewardDebt) + p.pending, 0n);
  return { seriesId, balance: s(x.vaultBalance), accNetWad: s(x.accNetWad), grossTotal: s(x.vaultGrossTotal), feesTotal: s(x.vaultFeesTotal), dust: s(x.vaultBalance - entitled < 0n ? 0n : x.vaultBalance - entitled) };
}

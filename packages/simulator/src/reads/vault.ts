import type { VaultState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { claimableNet } from '../engine/holders.ts';
import { claimableRedemption, claimableTail } from '../engine/redemption.ts';
import { claimableFinal } from '../engine/terminal.ts';

/**
 * The payout vault as the API shows it: the stablecoin it holds, Stage 1's net accumulator, our life-to-date gross and
 * fee totals (regular and tail payments; the accounting reconciliation compares them with the indexed payments) and
 * the dust: what the vault holds beyond every holder's claim (net payout, an unclaimed redemption with its tail
 * catch-up, the tail and the final pool).
 */
export function toVaultState(seriesId: string, x: SimSeries): VaultState {
  let entitled = 0n;
  for (const p of x.positions.values()) entitled += claimableNet(x, p) + claimableRedemption(x, p) + claimableTail(x, p) + claimableFinal(x, p);
  const dust = x.vaultBalance - entitled;
  return { seriesId, balance: s(x.vaultBalance), accNetWad: s(x.vault.netAccWad), grossTotal: s(x.grossPaidTotal), feesTotal: s(x.feesTotal), dust: s(dust < 0n ? 0n : dust) };
}

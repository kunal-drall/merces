import type { VaultState } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { claimableNet } from '../engine/holders.ts';
import { claimableRedemption, tailOwed } from '../engine/redemption.ts';
import { claimableFinal } from '../engine/terminal.ts';

/**
 * The payout vault as the API shows it: the stablecoin it holds, Stage 1's net accumulator, our life-to-date gross and
 * fee totals (regular and tail payments; the accounting reconciliation compares them with the indexed payments) and
 * the dust: what the vault holds beyond every holder's claim (net payout, an unclaimed redemption with its tail
 * catch-up, the tail owed from the holder's tail cursor on, counting the units its redemption would still redeem as
 * Stage 1's `claim_tail` does, and the final pool).
 *
 * On a curve series (B-C11) the holders' claims are what their stakes earned (with an unredeemed extinguishment's final
 * share), the tail and final share on their tendered units, and the redemption deposit not yet tendered (it is held for
 * every unit counted at redemption, wallets' included); the share of the units nobody staked is never anyone's and
 * stays as dust.
 */
export function toVaultState(seriesId: string, x: SimSeries): VaultState {
  let entitled = 0n;
  for (const p of x.positions.values()) entitled += claimableNet(x, p) + claimableRedemption(x, p) + tailOwed(x, p) + claimableFinal(x, p);
  if (x.curve && x.redemption) entitled += x.redemption.deposit - x.redemption.claimed;
  const dust = x.vaultBalance - entitled;
  return { seriesId, balance: s(x.vaultBalance), accNetWad: s(x.vault.netAccWad), grossTotal: s(x.grossPaidTotal), feesTotal: s(x.feesTotal), dust: s(dust < 0n ? 0n : dust) };
}

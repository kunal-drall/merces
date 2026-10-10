import { ChainError, type Command } from '@merces/domain';
import { U64_MAX, scaledAmount, walletTenderFits } from '@merces/math';
import type { SimCurve, SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, balKey, str, u64, type EngineCore, type Emit } from './core.ts';
import { curveOf } from './curve.ts';
import { fail, guardStage1 } from './errors.ts';
import { settleHolder } from './holders.ts';

/**
 * Curve staking on Stage 1 (SPEC §9; Solana `merces_protocol` curve.rs:1216-1528; S3 WP10), Solana only.
 *
 * On a curve series only staked units earn: a registered holder moves base lamports from its wallet into the series'
 * stake vault (`stakeUnits`) and is paid on its stake by the vault's accumulator from then on; units in wallets earn
 * nothing. Every stake change settles the holder first (Stage 1 `settle_curve_holder`, `settleHolder` on a curve: the
 * debt pattern), so a stake pays exactly for the receipts that arrived while it was staked. `unstakeUnits` returns
 * units at any time and credits what they earned into the holder's pending payout; it moves no stablecoin (Stage 1's
 * code: its accounts have no stablecoin account; SPEC §9 says "pays", the code wins, owner decision 1), and a claim
 * pays it later, the credit never lapses. After a redemption a curve series is redeemed by tender (`tenderUnits`):
 * staked units are reserved, wallet units share what is left of the count taken at redemption.
 *
 * Check orders are Stage 1's in-handler orders. On Solana the holder record is an account the instruction loads first,
 * so an unregistered wallet fails before every check (an adapter note, S3 critique); here it fails where the handler
 * settles it (HolderNotRegistered).
 */

function walletBase(e: EngineCore, c: SimCurve, wallet: string): bigint {
  return e.state.balances.get(balKey(wallet, c.baseMint)) ?? 0n;
}

/** The registered holder record of `wallet`, if any (settling refuses a missing or unregistered one: HolderNotRegistered). */
function holderOf(s: SimSeries, wallet: string): SimPosition | undefined {
  return s.positions.get(wallet);
}

/** Settle `wallet` as Stage 1's handlers do (HolderNotRegistered for a wallet that is not a registered holder). */
function settleWallet(e: EngineCore, s: SimSeries, wallet: string): SimPosition {
  const p = holderOf(s, wallet);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleHolder(e, s, p);
  return p;
}

/**
 * Stage 1 `stake_units(units)` (curve.rs:1250-1313). Checks and effects, in order:
 *
 *  1. a curve series (NotCurveMode);
 *  2. the raise is Open or Settled (RaiseNotOpen): a holder may stake while the curve still sells, once a census covers
 *     the stake (nothing accrues before the first payment);
 *  3. the stored status is not terminal (TerminalStatus): stakes close at retirement, redemption and extinguishment;
 *  4. `units > 0` (ZeroUnits);
 *  5. the wallet is allowlisted now (NotAllowlisted; a holder taken off the allowlist can still unstake and claim);
 *  6. `stakedTotal + units ≤ unitsOutstanding`, the last census (StakeExceedsOutstanding): nobody stakes before the first
 *     census, and units that left protocol accounts since need a census first;
 *  7. the holder is settled at its old stake (HolderNotRegistered);
 *  8. its wallet holds the units (InsufficientFunds: the token program's own error, no Stage 1 name).
 *
 * The units move from the wallet into the stake vault (not protocol-held: the census still counts them); the holder's
 * stake and the series' stakes grow. Units outstanding do not change. Emits `UnitsStaked{units, staked}`.
 */
export function stakeUnits(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'stakeUnits' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  if (s.phase !== 'Open' && s.phase !== 'Settled') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (TERMINAL.has(s.status)) fail('TerminalStatus', `series is ${s.status}`);
  const units = u64(cmd.units);
  if (units === 0n) fail('ZeroUnits', 'stake at least one base unit');
  e.requireAllowlisted(signer);
  const stakedAfter = s.stakedTotal + units;
  if (stakedAfter > U64_MAX) fail('AmountOutOfRange', 'the stakes are out of the u64 range');
  if (stakedAfter > s.unitsOutstanding) fail('StakeExceedsOutstanding', 'the stakes would pass the units counted by the last census: take a census first');
  const p = settleWallet(e, s, signer);
  if (walletBase(e, c, signer) < units) throw new ChainError('InsufficientFunds', 'the wallet holds fewer units');
  e.debit(signer, c.baseMint, units);
  e.credit(c.accounts.stakeVault, c.baseMint, units);
  p.stakedUnits += units;
  s.stakedTotal = stakedAfter;
  emit('UnitsStaked', { seriesId: s.seriesId, holder: signer, units: str(units), staked: str(p.stakedUnits) });
}

/**
 * Stage 1 `unstake_units(units)` (curve.rs:1338-1383), in any status and with no allowlist check. Checks and effects,
 * in order:
 *
 *  1. a curve series (NotCurveMode);
 *  2. `units > 0` (ZeroUnits);
 *  3. `units ≤` the holder's stake (InsufficientStake);
 *  4. the holder is settled (HolderNotRegistered): what its stake earned, and on an extinguished series that did not
 *     redeem its final-pool share, go into its pending payout.
 *
 * The units go back from the stake vault to the wallet; the holder's stake and the series' stakes fall. No stablecoin
 * moves: the pending payout stays on the holder record until a claim pays it (`claimPayout` pays it for any registered
 * holder, with no status or allowlist check, and holder records are never closed, so it is never lost). Emits
 * `UnitsUnstaked{units, staked}`.
 */
export function unstakeUnits(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'unstakeUnits' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  const units = u64(cmd.units);
  if (units === 0n) fail('ZeroUnits', 'unstake at least one base unit');
  if (units > (holderOf(s, signer)?.stakedUnits ?? 0n)) fail('InsufficientStake', 'more units than the holder has staked');
  const p = settleWallet(e, s, signer);
  e.debit(c.accounts.stakeVault, c.baseMint, units);
  e.credit(signer, c.baseMint, units);
  p.stakedUnits -= units;
  s.stakedTotal -= units;
  emit('UnitsUnstaked', { seriesId: s.seriesId, holder: signer, units: str(units), staked: str(p.stakedUnits) });
}

/**
 * Stage 1 `tender_units(from_stake, from_wallet)` (curve.rs:1426-1528), a curve series' redemption, with no allowlist
 * check. Checks and effects, in order:
 *
 *  1. a curve series (NotCurveMode);
 *  2. the series redeemed (NotRedeemed; Stage 1 checks the redemption time, not the status: an extinguished series that
 *     redeemed still takes tenders);
 *  3. `fromStake + fromWallet > 0` (ZeroUnits);
 *  4. `fromStake ≤` the holder's stake (InsufficientStake);
 *  5. the wallet part fits the tender quota, `tendered + staked + fromWallet ≤ unitsAtRedemption` (TenderQuotaExhausted,
 *     `walletTenderFits`): staked units are reserved for their holders, wallet units share what is left, so the deposit
 *     is never exceeded although units keep circulating after the redemption;
 *  6. the holder is settled (HolderNotRegistered: a wallet that never registered cannot tender);
 *  7. its wallet holds `fromWallet` (InsufficientFunds: the token program's own error, no Stage 1 name).
 *
 * The staked part burns in the stake vault and the wallet part in the wallet (the unit mint's supply falls); the
 * holder's stake and the series' stakes fall by `fromStake`; the series' tendered units and the holder's redeemed units
 * grow by both. The holder is paid `floor(P_redeem × units / 10^6)` (`scaledAmount`) plus its pending payout from the
 * redemption deposit. A tender pays no tail catch-up (Stage 1 has none on a curve) and takes no census: units
 * outstanding stay the count taken at redemption.
 *
 * Events: `PayoutClaimed{burnedUnits: 0}` for the pending payout (only when above 0: it is split out of the redemption,
 * whose own event carries the principal; S3 D3), `UnitsBurned{units, reason: redemption}`, then
 * `RedemptionClaimed{units, amount: principal, fromStake}` (Stage 1's event carries the total and no `fromStake`; the
 * Solana adapter splits and derives them).
 */
export function tenderUnits(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'tenderUnits' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  const r = s.redemption;
  if (!r) fail('NotRedeemed', 'the series has not redeemed');
  const fromStake = u64(cmd.fromStake);
  const fromWallet = u64(cmd.fromWallet);
  const units = fromStake + fromWallet;
  if (units > U64_MAX) fail('AmountOutOfRange', 'the tendered units are out of the u64 range');
  if (units === 0n) fail('ZeroUnits', 'tender at least one base unit');
  if (fromStake > (holderOf(s, signer)?.stakedUnits ?? 0n)) fail('InsufficientStake', 'more units than the holder has staked');
  if (!guardStage1(() => walletTenderFits(r.unitsAtRedemption, s.tenderedTotal, s.stakedTotal, fromWallet), 'AmountOutOfRange')) {
    fail('TenderQuotaExhausted', 'the wallet units would pass what is left of the units counted at redemption');
  }
  const p = settleWallet(e, s, signer);
  if (walletBase(e, c, signer) < fromWallet) throw new ChainError('InsufficientFunds', 'the wallet holds fewer units');
  // the burns: the staked part by the stake vault, the wallet part by the holder; the mint's supply falls by both
  e.debit(c.accounts.stakeVault, c.baseMint, fromStake);
  e.debit(signer, c.baseMint, fromWallet);
  c.supply -= units;
  p.stakedUnits -= fromStake;
  s.stakedTotal -= fromStake;
  s.tenderedTotal += units;
  p.redeemedUnits += units;
  const principal = guardStage1(() => scaledAmount(r.pricePerUnit, units, s.unitScale), 'AmountOutOfRange');
  const pending = p.pending;
  const amount = pending + principal;
  p.pending = 0n;
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: the deposit covers every unit counted at redemption
  s.vaultBalance -= amount;
  e.credit(signer, s.terms.stablecoinMint, amount);
  if (pending > 0n) {
    s.vaultDistributedNet += pending;
    p.claimedTotal += pending;
    emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(pending), burnedUnits: '0' });
  }
  r.claimed += principal;
  emit('UnitsBurned', { seriesId: s.seriesId, holder: signer, units: str(units), reason: 'redemption' });
  emit('RedemptionClaimed', { seriesId: s.seriesId, holder: signer, units: str(units), amount: str(principal), fromStake: str(fromStake) });
}

/**
 * The wallet units a tender may still take from the quota (Stage 1 `units_at_redemption − tendered − staked`), for the
 * reads; 0 before a redemption.
 */
export function tenderQuotaLeft(s: SimSeries): bigint {
  if (!s.redemption) return 0n;
  const left = s.redemption.unitsAtRedemption - s.tenderedTotal - s.stakedTotal;
  return left > 0n ? left : 0n;
}

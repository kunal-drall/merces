/**
 * The payout vault at a unit scale, ported from Stage 1's Rust (merces-common @1bfc66b `vault.rs`; A-MATH-3).
 *
 * At scale 1 each function returns what Stage 1's own TypeScript function returns (it calls it). At any other scale it
 * runs that function's body (`@merces/reference` `math/vault.ts`, `math/redemption.ts`) with the one change the Rust
 * makes: the cap is `scaledCapWad(cap, scale)` instead of `cap × WAD` (`vault.rs:54` in `receive_capped`; the tail uses
 * the same `receive_capped`, Solana `common.rs:595-612`). Everything else, the accumulator and its exact carry, the
 * `year_gross` ring and the fee, is per accounting unit already and is unchanged.
 */
import { BPS_DENOMINATOR, WAD, mulDiv, yearGrossAdd } from '@merces/sdk';
import {
  accumulate,
  isCapped,
  tailReceive,
  vaultReceiveGross,
  type ReceiveResult,
  type TailReceiveResult,
  type TailState,
  type VaultState,
} from '@merces/reference';
import { scaledCapWad } from './scale.ts';

/**
 * `retire_if_capped`'s test at a unit scale: `paid_per_unit_wad ≥ scaled_cap_wad(cap, scale)` (`vault.rs:167-170`
 * `is_capped`). Scale 1: Stage 1's `isCapped`.
 */
export function isCappedScaled(state: Pick<VaultState, 'paidPerUnitWad'>, capPerUnitValue: bigint, unitScale: bigint): boolean {
  if (unitScale === 1n) return isCapped(state, capPerUnitValue);
  return state.paidPerUnitWad >= scaledCapWad(capPerUnitValue, unitScale);
}

/**
 * `vault_receive_gross(G)` at a unit scale: `N` is in accounting units (base lamports on a curve series), the cap per
 * whole unit, and `cap_eff_wad = max(scaled_cap_wad(cap, scale), paid_per_unit_wad)` (`vault.rs:48-78`
 * `receive_capped`). Scale 1: Stage 1's `vaultReceiveGross`.
 */
export function vaultReceiveGrossScaled(
  state: VaultState,
  G: bigint,
  N: bigint,
  capPerUnitValue: bigint,
  unitScale: bigint,
  payoutFeeBps: number,
  settlementYearIndex: number,
): { state: VaultState; result: ReceiveResult } {
  if (unitScale === 1n) return vaultReceiveGross(state, G, N, capPerUnitValue, payoutFeeBps, settlementYearIndex);
  // Stage 1's `vaultReceiveGross` body (reference math/vault.ts:67-103), with the scaled cap
  if (N <= 0n) throw new Error('NoUnitsOutstanding');
  if (G < 0n) throw new RangeError('negative gross');
  const capWad = scaledCapWad(capPerUnitValue, unitScale);
  const capEff = capWad > state.paidPerUnitWad ? capWad : state.paidPerUnitWad;
  let incWad = mulDiv(G, WAD, N);
  let accepted: bigint;
  let refund = 0n;
  let retired = state.retired;
  if (state.paidPerUnitWad + incWad < capEff) {
    accepted = G;
  } else {
    const remainingWad = capEff - state.paidPerUnitWad;
    accepted = mulDiv(remainingWad, N, WAD);
    incWad = mulDiv(accepted, WAD, N);
    refund = G - accepted;
    retired = true;
  }
  const paidPerUnitWad = state.paidPerUnitWad + incWad;
  const yearGross = yearGrossAdd(state.yearGross, settlementYearIndex < 0 ? 0 : settlementYearIndex, incWad);
  const fee = mulDiv(accepted, BigInt(payoutFeeBps), BPS_DENOMINATOR);
  const net = accepted - fee;
  const acc = accumulate(state.netAccWad, state.carryWad, net, N);
  return {
    state: {
      ...state,
      paidPerUnitWad,
      netAccWad: acc.accWad,
      carryWad: acc.carryWad,
      grossReceived: state.grossReceived + accepted,
      feeCollected: state.feeCollected + fee,
      refundedToIssuer: state.refundedToIssuer + refund,
      retired,
      yearGross,
    },
    result: { accepted, refund, incWad, fee, netAdded: net, deltaAccWad: acc.deltaAccWad, carryWad: acc.carryWad, retired },
  };
}

/**
 * `vault_receive_tail(G)` at a unit scale: `units_at_redemption` in accounting units, the tail cap per whole unit and
 * `cap_wad = scaled_cap_wad(tail_cap_per_unit, scale)` (Solana `common.rs:595-612` `receive_tail` →
 * `vault.rs:48-78` `receive_capped`). Scale 1: Stage 1's `tailReceive`.
 */
export function tailReceiveScaled(
  state: TailState,
  G: bigint,
  unitsAtRedemption: bigint,
  payoutFeeBps: number,
  unitScale: bigint,
): { state: TailState; result: TailReceiveResult } {
  if (unitScale === 1n) return tailReceive(state, G, unitsAtRedemption, payoutFeeBps);
  // Stage 1's `tailReceive` body (reference math/redemption.ts:104-134), with the scaled cap
  const N = unitsAtRedemption;
  if (N <= 0n) throw new Error('NoUnitsOutstanding');
  const capWad = scaledCapWad(state.tailCapPerUnit, unitScale);
  let incWad = mulDiv(G, WAD, N);
  let accepted = G;
  let refund = 0n;
  let exhausted = state.tailExhausted;
  if (!(state.tailPaidPerUnitWad + incWad < capWad)) {
    const remaining = capWad - state.tailPaidPerUnitWad;
    accepted = mulDiv(remaining, N, WAD);
    incWad = mulDiv(accepted, WAD, N);
    refund = G - accepted;
    exhausted = true;
  }
  const fee = mulDiv(accepted, BigInt(payoutFeeBps), BPS_DENOMINATOR);
  const acc = accumulate(state.tailAccWad, state.tailCarryWad, accepted - fee, N);
  return {
    state: {
      ...state,
      tailPaidPerUnitWad: state.tailPaidPerUnitWad + incWad,
      tailAccWad: acc.accWad,
      tailCarryWad: acc.carryWad,
      tailExhausted: exhausted,
      tailFeeCollected: state.tailFeeCollected + fee,
      tailGrossReceived: state.tailGrossReceived + accepted,
      tailRefunded: state.tailRefunded + refund,
    },
    result: { accepted, refund, fee, deltaAccWad: acc.deltaAccWad, exhausted },
  };
}

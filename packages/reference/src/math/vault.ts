/**
 * Payout vault accounting (SPEC §6.3, brief C6): cap truncation, carry, fee and the
 * reward-per-share accumulator.
 *
 * Carry: SPEC §6.3 writes `carry = net − floor(delta_acc × N / WAD)` in base units. That re-adds a
 * whole base unit the accumulator already represents (all but `(net × WAD mod N) / WAD` of it), so
 * after a few distributions holders can claim more than the vault holds — violating the brief (C2:
 * "never lets holders be paid more than the vault holds"). The reference therefore keeps the exact
 * WAD-scaled remainder: `num = net × WAD + carry_wad; delta = floor(num / N); carry_wad = num − delta × N`
 * (`0 ≤ carry_wad < N`). Then `net_acc_wad × N ≤ Σ net × WAD` always, so total claims never exceed
 * the vault. See docs/assumptions/track-a.md (SPEC defect S1).
 */
import { BPS_DENOMINATOR, WAD, mulDiv } from "@merces/sdk";

export interface VaultState {
  capPerUnit: bigint;
  paidPerUnitWad: bigint;
  netAccWad: bigint;
  /** exact undistributed remainder, WAD-scaled: `0 ≤ carryWad < N` */
  carryWad: bigint;
  grossReceived: bigint;
  feeCollected: bigint;
  refundedToIssuer: bigint;
  retired: boolean;
  /** indexed by settlement year `floor((now − settlement_ts) / YEAR)` */
  yearGrossWad: bigint[];
}

export function newVaultState(capPerUnit: bigint): VaultState {
  return { capPerUnit, paidPerUnitWad: 0n, netAccWad: 0n, carryWad: 0n, grossReceived: 0n, feeCollected: 0n, refundedToIssuer: 0n, retired: false, yearGrossWad: [] };
}

export interface ReceiveResult {
  accepted: bigint;
  refund: bigint;
  incWad: bigint;
  fee: bigint;
  /** `accepted − fee`: net stablecoin added to the distributable pool */
  netAdded: bigint;
  deltaAccWad: bigint;
  /** remainder after this distribution, WAD-scaled */
  carryWad: bigint;
  retired: boolean;
}

/** `cap_per_unit = floor(cap_multiple_wad × P0 / WAD)` */
export function capPerUnit(capMultipleWad: bigint, clearingPrice: bigint): bigint {
  return mulDiv(capMultipleWad, clearingPrice, WAD);
}

/**
 * `vault_receive_gross(G)` with `N` units outstanding. Returns the new state and the breakdown.
 * Throws `NoUnitsOutstanding` when `N == 0`.
 */
export function vaultReceiveGross(state: VaultState, G: bigint, N: bigint, payoutFeeBps: number, settlementYear: number): { state: VaultState; result: ReceiveResult } {
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  if (G < 0n) throw new RangeError("negative gross");
  const capWad = state.capPerUnit * WAD;
  let incWad = mulDiv(G, WAD, N);
  let accepted: bigint;
  let refund = 0n;
  let retired = state.retired;
  if (state.paidPerUnitWad + incWad < capWad) {
    accepted = G;
  } else {
    const remainingWad = capWad - state.paidPerUnitWad;
    accepted = mulDiv(remainingWad, N, WAD);
    incWad = mulDiv(accepted, WAD, N);
    refund = G - accepted;
    retired = true;
  }
  const paidPerUnitWad = state.paidPerUnitWad + incWad;
  const yearGrossWad = [...state.yearGrossWad];
  while (yearGrossWad.length <= settlementYear) yearGrossWad.push(0n);
  yearGrossWad[settlementYear] = yearGrossWad[settlementYear]! + incWad;

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
      yearGrossWad,
    },
    result: { accepted, refund, incWad, fee, netAdded: net, deltaAccWad: acc.deltaAccWad, carryWad: acc.carryWad, retired },
  };
}

/** Pending payout accrued by a holder since its last settlement: `floor((acc − last) × balance / WAD)`. */
export function settleHolderDelta(accWad: bigint, lastAccWad: bigint, balance: bigint): bigint {
  if (accWad < lastAccWad) throw new RangeError("accumulator went backwards");
  return mulDiv(accWad - lastAccWad, balance, WAD);
}

/**
 * Exact reward-per-share step shared by the payout, tail and final accumulators:
 * `num = amount × WAD + carry_wad; delta = floor(num / N); carry_wad = num − delta × N`.
 * Invariant: `(acc + delta) × N + carry_wad' == acc × N + carry_wad + amount × WAD`, so the
 * accumulator never represents more money than was added.
 */
export function accumulate(accWad: bigint, carryWad: bigint, amount: bigint, N: bigint): { accWad: bigint; carryWad: bigint; deltaAccWad: bigint } {
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  if (amount < 0n || carryWad < 0n) throw new RangeError("negative amount");
  const num = amount * WAD + carryWad;
  const deltaAccWad = num / N;
  return { accWad: accWad + deltaAccWad, carryWad: num - deltaAccWad * N, deltaAccWad };
}

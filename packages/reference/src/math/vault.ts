/**
 * Payout vault accounting (SPEC v1.1 §6.3, brief C6): live cap with the effective-cap rule, cap
 * truncation and retirement, fee, the tagged `year_gross` ring and the reward-per-share
 * accumulator.
 *
 * Carry: SPEC §6.3 (still in v1.1) writes `carry = net − floor(delta_acc × N / WAD)` in base units.
 * That re-adds a whole base unit the accumulator already represents (all but `(net × WAD mod N)/WAD`
 * of it), so after a few distributions holders can claim more than the vault holds — violating the
 * brief (C2: "never lets holders be paid more than the vault holds"). The reference keeps the exact
 * WAD-scaled remainder instead: `num = net × WAD + carry_wad; delta = floor(num / N);
 * carry_wad = num − delta × N` (`0 ≤ carry_wad < N`), so `net_acc_wad × N ≤ Σ net × WAD` always and
 * total claims never exceed the vault. Both readings agree whenever `N` divides `net × 10^18`, which
 * holds in every parity vector. See docs/assumptions/track-a.md (SPEC defect S1, still open).
 */
import { BPS_DENOMINATOR, WAD, mulDiv, newYearGross, yearGrossAdd, type YearGrossRing } from "@merces/sdk";

export interface VaultState {
  paidPerUnitWad: bigint;
  netAccWad: bigint;
  /** exact undistributed remainder, WAD-scaled: `0 ≤ carryWad < N` */
  carryWad: bigint;
  grossReceived: bigint;
  feeCollected: bigint;
  refundedToIssuer: bigint;
  retired: boolean;
  /** tagged 4-slot ring indexed by settlement year */
  yearGross: YearGrossRing;
}

export function newVaultState(): VaultState {
  return { paidPerUnitWad: 0n, netAccWad: 0n, carryWad: 0n, grossReceived: 0n, feeCollected: 0n, refundedToIssuer: 0n, retired: false, yearGross: newYearGross() };
}

export interface ReceiveResult {
  accepted: bigint;
  refund: bigint;
  incWad: bigint;
  fee: bigint;
  /** `accepted − fee`: net stablecoin added to the distributable pool */
  netAdded: bigint;
  deltaAccWad: bigint;
  carryWad: bigint;
  retired: boolean;
}

/** `cap_per_unit() = floor(cap_multiple_wad × P0 / WAD)` — read live at every use. */
export function capPerUnit(capMultipleWad: bigint, clearingPrice: bigint): bigint {
  return mulDiv(capMultipleWad, clearingPrice, WAD);
}

/** `cap_eff_wad = max(cap_per_unit × WAD, paid_per_unit_wad)`: a lowered cap never underflows. */
export function capEffWad(capPerUnitValue: bigint, paidPerUnitWad: bigint): bigint {
  const capWad = capPerUnitValue * WAD;
  return capWad > paidPerUnitWad ? capWad : paidPerUnitWad;
}

/** `retire_if_capped`: true when `cap_eff_wad − paid_per_unit_wad == 0`. */
export function isCapped(state: Pick<VaultState, "paidPerUnitWad">, capPerUnitValue: bigint): boolean {
  return capEffWad(capPerUnitValue, state.paidPerUnitWad) === state.paidPerUnitWad;
}

/**
 * `vault_receive_gross(G, source, period_for_year)` with `N = units_outstanding` and the cap read
 * live. `settlementYearIndex` is `settlement_year(anchor)` (anchor = the period's deadline for
 * payments, `now` for router income). Throws `NoUnitsOutstanding` when `N == 0`.
 */
export function vaultReceiveGross(state: VaultState, G: bigint, N: bigint, capPerUnitValue: bigint, payoutFeeBps: number, settlementYearIndex: number): { state: VaultState; result: ReceiveResult } {
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  if (G < 0n) throw new RangeError("negative gross");
  const capEff = capEffWad(capPerUnitValue, state.paidPerUnitWad);
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

/** Pending payout accrued by a holder since its last settlement: `floor((acc − last) × accrual_units / WAD)`. */
export function settleHolderDelta(accWad: bigint, lastAccWad: bigint, accrualUnits: bigint): bigint {
  if (accWad < lastAccWad) throw new RangeError("accumulator went backwards");
  return mulDiv(accWad - lastAccWad, accrualUnits, WAD);
}

/**
 * Exact reward-per-share step shared by the payout, tail and final accumulators (each with its own
 * carry): `num = amount × WAD + carry_wad; delta = floor(num / N); carry_wad = num − delta × N`.
 */
export function accumulate(accWad: bigint, carryWad: bigint, amount: bigint, N: bigint): { accWad: bigint; carryWad: bigint; deltaAccWad: bigint } {
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  if (amount < 0n || carryWad < 0n) throw new RangeError("negative amount");
  const num = amount * WAD + carryWad;
  const deltaAccWad = num / N;
  return { accWad: accWad + deltaAccWad, carryWad: num - deltaAccWad * N, deltaAccWad };
}

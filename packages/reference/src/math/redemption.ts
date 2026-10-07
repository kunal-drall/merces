/**
 * Redemption price, tail clause and extinguishment distribution (SPEC §6.7–§6.9, brief C7, C11 §6).
 */
import { BPS_DENOMINATOR, WAD, YEAR, mulDiv, mulDivCeil } from "@merces/sdk";
import { accumulate } from "./vault.js";

export interface HurdleResult {
  pHurdle: bigint;
  years: bigint;
  fracWad: bigint;
}

/**
 * `P_hurdle = P0 × (1 + h)^floor(t) × (1 + h × frac(t))`, computed as repeated WAD multiplications
 * with floor rounding at every step (SPEC §6.7).
 */
export function hurdlePrice(p0: bigint, hurdleRateWad: bigint, t: bigint): HurdleResult {
  if (t < 0n) throw new RangeError("t must be ≥ 0");
  const years = t / YEAR;
  const fracWad = mulDiv(t - years * YEAR, WAD, YEAR);
  let p = p0;
  for (let i = 0n; i < years; i++) p = mulDiv(p, WAD + hurdleRateWad, WAD);
  p = mulDiv(p, WAD + mulDiv(hurdleRateWad, fracWad, WAD), WAD);
  return { pHurdle: p, years, fracWad };
}

/**
 * `D_avg`: average annual gross payment per unit over the trailing `min(Y, 3)` full years, or null
 * when less than one full year has elapsed.
 */
export function averageAnnualGross(yearGrossWad: readonly bigint[], years: bigint): bigint | null {
  if (years < 1n) return null;
  const n = years < 3n ? years : 3n;
  let sum = 0n;
  for (let y = years - n; y < years; y++) sum += yearGrossWad[Number(y)] ?? 0n;
  return sum / (n * WAD);
}

export interface RedemptionInputs {
  p0: bigint;
  hurdleRateWad: bigint;
  payoutMultipleK: number;
  /** now − settlement_ts */
  t: bigint;
  capPerUnit: bigint;
  paidPerUnitWad: bigint;
  yearGrossWad: readonly bigint[];
  unitsOutstanding: bigint;
}

export interface RedemptionQuote {
  pRedeem: bigint;
  pHurdle: bigint;
  dAvg: bigint | null;
  cRemaining: bigint;
  paidUnits: bigint;
  floorTerm: bigint;
  deposit: bigint;
  tailCapPerUnit: bigint;
  /** which of the three terms decided the price */
  decidedBy: "cap_remaining" | "hurdle" | "payout_multiple";
}

export function redemptionQuote(i: RedemptionInputs): RedemptionQuote {
  const { pHurdle, years } = hurdlePrice(i.p0, i.hurdleRateWad, i.t);
  const paidUnits = mulDivCeil(i.paidPerUnitWad, 1n, WAD);
  const cRemaining = i.capPerUnit > paidUnits ? i.capPerUnit - paidUnits : 0n;
  const dAvg = averageAnnualGross(i.yearGrossWad, years);
  let floorTerm = pHurdle;
  let decidedBy: RedemptionQuote["decidedBy"] = "hurdle";
  if (dAvg !== null) {
    const kd = BigInt(i.payoutMultipleK) * dAvg;
    if (kd > pHurdle) {
      floorTerm = kd;
      decidedBy = "payout_multiple";
    }
  }
  let pRedeem = floorTerm;
  if (cRemaining < floorTerm) {
    pRedeem = cRemaining;
    decidedBy = "cap_remaining";
  }
  return { pRedeem, pHurdle, dAvg, cRemaining, paidUnits, floorTerm, deposit: pRedeem * i.unitsOutstanding, tailCapPerUnit: cRemaining - pRedeem, decidedBy };
}

export interface TailState {
  tailCapPerUnit: bigint;
  tailPaidPerUnitWad: bigint;
  tailAccWad: bigint;
  tailCarryWad: bigint;
  tailFeeCollected: bigint;
  tailGrossReceived: bigint;
  tailRefunded: bigint;
}

export function newTailState(tailCapPerUnit: bigint): TailState {
  return { tailCapPerUnit, tailPaidPerUnitWad: 0n, tailAccWad: 0n, tailCarryWad: 0n, tailFeeCollected: 0n, tailGrossReceived: 0n, tailRefunded: 0n };
}

export interface TailReceiveResult {
  accepted: bigint;
  refund: bigint;
  fee: bigint;
  deltaAccWad: bigint;
}

/** `vault_receive_tail(G)` with `N = units_at_redemption` (SPEC §6.8). */
export function tailReceive(state: TailState, G: bigint, unitsAtRedemption: bigint, payoutFeeBps: number): { state: TailState; result: TailReceiveResult } {
  const N = unitsAtRedemption;
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  const capWad = state.tailCapPerUnit * WAD;
  let incWad = mulDiv(G, WAD, N);
  let accepted = G;
  let refund = 0n;
  if (state.tailPaidPerUnitWad + incWad > capWad) {
    accepted = mulDiv(capWad - state.tailPaidPerUnitWad, N, WAD);
    incWad = mulDiv(accepted, WAD, N);
    refund = G - accepted;
  }
  const fee = mulDiv(accepted, BigInt(payoutFeeBps), BPS_DENOMINATOR);
  const acc = accumulate(state.tailAccWad, state.tailCarryWad, accepted - fee, N);
  return {
    state: {
      ...state,
      tailPaidPerUnitWad: state.tailPaidPerUnitWad + incWad,
      tailAccWad: acc.accWad,
      tailCarryWad: acc.carryWad,
      tailFeeCollected: state.tailFeeCollected + fee,
      tailGrossReceived: state.tailGrossReceived + accepted,
      tailRefunded: state.tailRefunded + refund,
    },
    result: { accepted, refund, fee, deltaAccWad: acc.deltaAccWad },
  };
}

export interface FinalState {
  finalAccWad: bigint;
  finalCarryWad: bigint;
  unreleasedDistributed: bigint;
}

/** Extinguishment: `final_acc_wad += floor(unreleased × WAD / N)`, no fee, carry as usual (SPEC §6.9). */
export function finalDistribute(state: FinalState, unreleased: bigint, N: bigint): { state: FinalState; deltaAccWad: bigint } {
  if (unreleased === 0n) return { state, deltaAccWad: 0n };
  const acc = accumulate(state.finalAccWad, state.finalCarryWad, unreleased, N);
  return { state: { finalAccWad: acc.accWad, finalCarryWad: acc.carryWad, unreleasedDistributed: state.unreleasedDistributed + unreleased }, deltaAccWad: acc.deltaAccWad };
}

/**
 * Redemption price, tail clause and extinguishment distribution (SPEC v1.1 §6.7–§6.9).
 */
import { BPS_DENOMINATOR, WAD, YEAR, mulDiv, mulDivCeil, yearGrossGet, type YearGrossRing } from "@merces/sdk";
import { accumulate } from "./vault.js";

export interface HurdleResult {
  pHurdle: bigint;
  years: bigint;
  fracWad: bigint;
}

/** `P_hurdle = P0 × (1 + h)^floor(t) × (1 + h × frac(t))` with floor rounding at every step. */
export function hurdlePrice(p0: bigint, hurdleRateWad: bigint, t: bigint): HurdleResult {
  if (t < 0n) throw new RangeError("t must be ≥ 0");
  const years = t / YEAR;
  const fracWad = mulDiv(t - years * YEAR, WAD, YEAR);
  let p = p0;
  for (let i = 0n; i < years; i++) p = mulDiv(p, WAD + hurdleRateWad, WAD);
  p = mulDiv(p, WAD + mulDiv(hurdleRateWad, fracWad, WAD), WAD);
  return { pHurdle: p, years, fracWad };
}

/** `D_avg` over the trailing `min(Y, 3)` full settlement years from the tagged ring, or null when `Y < 1`. */
export function averageAnnualGross(yearGross: YearGrossRing, years: bigint): bigint | null {
  if (years < 1n) return null;
  const n = years < 3n ? years : 3n;
  let sum = 0n;
  for (let y = years - n; y < years; y++) sum += yearGrossGet(yearGross, Number(y));
  return sum / (n * WAD);
}

export interface RedemptionInputs {
  p0: bigint;
  hurdleRateWad: bigint;
  payoutMultipleK: number;
  /** now − settlement_ts */
  t: bigint;
  /** `cap_per_unit()` read live */
  capPerUnit: bigint;
  paidPerUnitWad: bigint;
  yearGross: YearGrossRing;
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
  decidedBy: "cap_remaining" | "hurdle" | "payout_multiple";
}

export function redemptionQuote(i: RedemptionInputs): RedemptionQuote {
  const { pHurdle, years } = hurdlePrice(i.p0, i.hurdleRateWad, i.t);
  const paidUnits = mulDivCeil(i.paidPerUnitWad, 1n, WAD);
  const cRemaining = i.capPerUnit > paidUnits ? i.capPerUnit - paidUnits : 0n;
  const dAvg = averageAnnualGross(i.yearGross, years);
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
  tailExhausted: boolean;
  tailFeeCollected: bigint;
  tailGrossReceived: bigint;
  tailRefunded: bigint;
}

export function newTailState(tailCapPerUnit: bigint): TailState {
  return { tailCapPerUnit, tailPaidPerUnitWad: 0n, tailAccWad: 0n, tailCarryWad: 0n, tailExhausted: false, tailFeeCollected: 0n, tailGrossReceived: 0n, tailRefunded: 0n };
}

export interface TailReceiveResult {
  accepted: bigint;
  refund: bigint;
  fee: bigint;
  deltaAccWad: bigint;
  exhausted: boolean;
}

/** `vault_receive_tail(G)` with `N = units_at_redemption` and the same `<` boundary as §6.3 (SPEC v1.1 §6.8). */
export function tailReceive(state: TailState, G: bigint, unitsAtRedemption: bigint, payoutFeeBps: number): { state: TailState; result: TailReceiveResult } {
  const N = unitsAtRedemption;
  if (N <= 0n) throw new Error("NoUnitsOutstanding");
  const capWad = state.tailCapPerUnit * WAD;
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

export interface FinalState {
  finalAccWad: bigint;
  finalCarryWad: bigint;
  finalUnits: bigint;
  unreleasedDistributed: bigint;
}

export function newFinalState(): FinalState {
  return { finalAccWad: 0n, finalCarryWad: 0n, finalUnits: 0n, unreleasedDistributed: 0n };
}

/**
 * Extinguishment: `final_acc_wad += floor(unreleased × WAD / final_units)` with its own carry, no fee;
 * `unreleased == 0` or `final_units == 0` → no distribution (SPEC v1.1 §6.9).
 */
export function finalDistribute(state: FinalState, unreleased: bigint, finalUnits: bigint): { state: FinalState; deltaAccWad: bigint } {
  const withUnits = { ...state, finalUnits };
  if (unreleased === 0n || finalUnits === 0n) return { state: withUnits, deltaAccWad: 0n };
  const acc = accumulate(state.finalAccWad, state.finalCarryWad, unreleased, finalUnits);
  return { state: { ...withUnits, finalAccWad: acc.accWad, finalCarryWad: acc.carryWad, unreleasedDistributed: state.unreleasedDistributed + unreleased }, deltaAccWad: acc.deltaAccWad };
}

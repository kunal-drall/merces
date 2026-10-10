/**
 * The redemption price at a unit scale, ported from Stage 1's Rust (merces-common @1bfc66b `redemption.rs:101-141`
 * `redemption_price`, and the deposit of Solana `exit.rs:125`; A-MATH-3).
 *
 * The accumulators (`paid_per_unit_wad`, `year_gross`) are per accounting unit; prices are per whole unit. Rust turns
 * one into the other with `per_unit_den = WAD / unit_scale`: `paid_units = ceil(paid / per_unit_den)` and
 * `D_avg = Σ year_gross / (n × per_unit_den)`; the deposit is `floor(P_redeem × N / unit_scale)`. At scale 1
 * `per_unit_den = WAD` and these are Stage 1's TypeScript formulas, so scale 1 returns Stage 1's own result.
 */
import { mulDivCeil, yearGrossGet, type YearGrossRing } from '@merces/sdk';
import { hurdlePrice, redemptionQuote, type RedemptionInputs, type RedemptionQuote } from '@merces/reference';
import { capRemaining } from '../cap.ts';
import { scaledAmount, wadPerScaledUnit } from './scale.ts';

/** Stage 1's `RedemptionInputs` with the series' unit scale (`unitsOutstanding` in accounting units). */
export type RedemptionInputsScaled = RedemptionInputs & { unitScale: bigint };

/**
 * `C_remaining` at a unit scale: `max(cap_per_unit − ceil(paid_per_unit_wad / (WAD / scale)), 0)`, the remaining cap per
 * whole unit, rounded in the issuer's favour (`redemption.rs:110-113`). Scale 1: our `capRemaining`, which is Stage 1's
 * `redemptionQuote(…).cRemaining`.
 */
export function capRemainingScaled(capPerUnit: bigint, paidPerUnitWad: bigint, unitScale: bigint): bigint {
  if (unitScale === 1n) return capRemaining(capPerUnit, paidPerUnitWad);
  const paidUnits = mulDivCeil(paidPerUnitWad, 1n, wadPerScaledUnit(unitScale));
  return capPerUnit > paidUnits ? capPerUnit - paidUnits : 0n;
}

/** Stage 1's `averageAnnualGross` with `per_unit_den` for `WAD` (`redemption.rs:114-127`). */
function averageAnnualGrossScaled(yearGross: YearGrossRing, years: bigint, perUnitDen: bigint): bigint | null {
  if (years < 1n) return null;
  const n = years < 3n ? years : 3n;
  let sum = 0n;
  for (let y = years - n; y < years; y++) sum += yearGrossGet(yearGross, Number(y));
  return sum / (n * perUnitDen);
}

/**
 * Stage 1's `redemptionQuote` at a unit scale (`redemption.rs:101-141` `redemption_price`; the deposit `exit.rs:125`
 * `scaled_amount(price, units, scale)`). Prices, `C_remaining`, `D_avg` and the tail cap stay per whole unit;
 * `paidUnits` is per whole unit too. Scale 1: Stage 1's `redemptionQuote`.
 */
export function redemptionQuoteScaled(i: RedemptionInputsScaled): RedemptionQuote {
  if (i.unitScale === 1n) return redemptionQuote(i);
  // Stage 1's `redemptionQuote` body (reference math/redemption.ts:58-78) with `per_unit_den` for WAD
  const { pHurdle, years } = hurdlePrice(i.p0, i.hurdleRateWad, i.t);
  const perUnitDen = wadPerScaledUnit(i.unitScale);
  const paidUnits = mulDivCeil(i.paidPerUnitWad, 1n, perUnitDen);
  const cRemaining = i.capPerUnit > paidUnits ? i.capPerUnit - paidUnits : 0n;
  const dAvg = averageAnnualGrossScaled(i.yearGross, years, perUnitDen);
  let floorTerm = pHurdle;
  let decidedBy: RedemptionQuote['decidedBy'] = 'hurdle';
  if (dAvg !== null) {
    const kd = BigInt(i.payoutMultipleK) * dAvg;
    if (kd > pHurdle) {
      floorTerm = kd;
      decidedBy = 'payout_multiple';
    }
  }
  let pRedeem = floorTerm;
  if (cRemaining < floorTerm) {
    pRedeem = cRemaining;
    decidedBy = 'cap_remaining';
  }
  return {
    pRedeem,
    pHurdle,
    dAvg,
    cRemaining,
    paidUnits,
    floorTerm,
    deposit: scaledAmount(pRedeem, i.unitsOutstanding, i.unitScale),
    tailCapPerUnit: cRemaining - pRedeem,
    decidedBy,
  };
}

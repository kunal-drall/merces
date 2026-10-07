import { WAD, assertNonNegative, max, mulDiv, wadMul } from './fixed.ts';

/**
 * C3. Payment formula, year-to-date method.
 *
 * owed_YTD(q)    = r × units_outstanding × max(0, income_YTD(q) − θ)   // income currency base units
 * payment(q)     = owed_YTD(q) − owed_YTD(q−1)
 * payment_usd(q) = payment(q) × fx_avg(q)                             // stablecoin base units
 *
 * Rounding favours the issuer: every division rounds down.
 */

/** r = s / N, in WAD. s is the series' total share rate in WAD. */
export function ratePerUnit(shareRateWad: bigint, unitsOffered: bigint): bigint {
  assertNonNegative(shareRateWad, 'shareRate');
  if (unitsOffered <= 0n) throw new RangeError('unitsOffered must be positive');
  return shareRateWad / unitsOffered;
}

/** owed_YTD in income-currency base units. */
export function owedYtd(ratePerUnitWad: bigint, unitsOutstanding: bigint, incomeYtd: bigint, threshold: bigint): bigint {
  assertNonNegative(ratePerUnitWad, 'ratePerUnit');
  assertNonNegative(unitsOutstanding, 'unitsOutstanding');
  assertNonNegative(incomeYtd, 'incomeYtd');
  assertNonNegative(threshold, 'threshold');
  const excess = max(0n, incomeYtd - threshold);
  // r × N × excess, rounded down once at the end.
  return mulDiv(ratePerUnitWad * unitsOutstanding, excess, WAD);
}

/** payment(q) = owed_YTD(q) − owed_YTD(q−1), never negative (a lower YTD owed can only come from an amended θ). */
export function periodPayment(owedYtdNow: bigint, owedYtdPrev: bigint): bigint {
  return max(0n, owedYtdNow - owedYtdPrev);
}

/** Convert an income-currency payment into stablecoin base units at fxAvg (WAD, stablecoin per income unit). */
export function toStablecoin(paymentIncomeUnits: bigint, fxAvgWad: bigint): bigint {
  assertNonNegative(paymentIncomeUnits, 'payment');
  assertNonNegative(fxAvgWad, 'fxAvg');
  return wadMul(paymentIncomeUnits, fxAvgWad);
}

/**
 * Whole quarter computation, for the device-side prover and for the simulator's test oracle.
 * `incomeYtdPrev` is the YTD income at the end of the previous quarter in the same reporting year (0 for Q1).
 */
export function quarterPayment(params: {
  ratePerUnitWad: bigint;
  unitsOutstanding: bigint;
  incomeYtdPrev: bigint;
  incomeYtdNow: bigint;
  threshold: bigint;
  fxAvgWad: bigint;
}): { owedPrev: bigint; owedNow: bigint; paymentIncome: bigint; paymentStable: bigint } {
  const owedPrev = owedYtd(params.ratePerUnitWad, params.unitsOutstanding, params.incomeYtdPrev, params.threshold);
  const owedNow = owedYtd(params.ratePerUnitWad, params.unitsOutstanding, params.incomeYtdNow, params.threshold);
  const paymentIncome = periodPayment(owedNow, owedPrev);
  return { owedPrev, owedNow, paymentIncome, paymentStable: toStablecoin(paymentIncome, params.fxAvgWad) };
}

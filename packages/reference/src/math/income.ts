/**
 * Year-to-date payment formula (brief C3, SPEC §8). Income, θ and payments are in the income
 * currency expressed at the stablecoin's decimals; `fx_avg_wad` is a pure WAD ratio (1e18 when the
 * income currency is the stablecoin). This is the canonical copy; the circuit enforces the same
 * arithmetic.
 */
import { WAD, assertU64 } from "@merces/sdk";

export function excess(incomeYtd: bigint, theta: bigint): bigint {
  return incomeYtd > theta ? incomeYtd - theta : 0n;
}

/** owed_YTD(x) = floor(r_wad × units_outstanding × max(0, x − θ) / WAD) */
export function owedYtd(rWad: bigint, unitsOutstanding: bigint, incomeYtd: bigint, theta: bigint): bigint {
  assertU64(rWad, "rWad");
  assertU64(unitsOutstanding, "unitsOutstanding");
  assertU64(incomeYtd, "incomeYtd");
  assertU64(theta, "theta");
  return (rWad * unitsOutstanding * excess(incomeYtd, theta)) / WAD;
}

/** payment(q) = owed_YTD(income_ytd) − owed_YTD(prior_income_ytd), in income currency. */
export function quarterPayment(rWad: bigint, unitsOutstanding: bigint, theta: bigint, incomeYtd: bigint, priorIncomeYtd: bigint): bigint {
  if (incomeYtd < priorIncomeYtd) throw new RangeError("income_ytd must be ≥ prior_income_ytd");
  return owedYtd(rWad, unitsOutstanding, incomeYtd, theta) - owedYtd(rWad, unitsOutstanding, priorIncomeYtd, theta);
}

/** payment_usd(q) = floor(payment(q) × fx_avg_wad / WAD), stablecoin base units. */
export function paymentUsd(args: {
  rWad: bigint;
  unitsOutstanding: bigint;
  theta: bigint;
  incomeYtd: bigint;
  priorIncomeYtd: bigint;
  fxAvgWad: bigint;
}): bigint {
  assertU64(args.fxAvgWad, "fxAvgWad");
  return (quarterPayment(args.rWad, args.unitsOutstanding, args.theta, args.incomeYtd, args.priorIncomeYtd) * args.fxAvgWad) / WAD;
}

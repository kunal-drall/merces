import { WAD, assertNonNegative, max, min, wadMul, wadPow1p } from './fixed.ts';
import { yearsSince } from './time.ts';
import { capRemaining } from './cap.ts';

/**
 * C7. Redemption at the formula price per unit.
 *
 * P_redeem    = min( C_remaining , max( P_hurdle , k × D_avg ) )
 * C_remaining = C − paid_per_unit
 * P_hurdle    = P0 × (1 + h)^floor(t) × (1 + h × frac(t))     t = years since auction settlement
 * D_avg       = average annual gross payment per unit over the trailing 3 years
 *               (< 3 full years: average over the full years elapsed; < 1 full year: omit the term)
 */

export function hurdlePrice(issuePrice: bigint, hurdleWad: bigint, settlementTs: number, nowTs: number): bigint {
  assertNonNegative(issuePrice, 'issuePrice');
  assertNonNegative(hurdleWad, 'hurdle');
  const { whole, fracWad } = yearsSince(settlementTs, nowTs);
  const compounded = wadPow1p(hurdleWad, whole); // (1+h)^floor(t) in WAD
  const linear = WAD + wadMul(hurdleWad, fracWad); // 1 + h × frac(t)
  return wadMul(wadMul(issuePrice, compounded), linear);
}

/**
 * D_avg from per-unit gross payments of completed years since settlement, oldest first.
 * `annualGrossPerUnit` must contain only FULL years elapsed; the caller derives it from history.
 */
export function averageAnnualPayout(annualGrossPerUnit: bigint[]): bigint | null {
  const years = annualGrossPerUnit.slice(-3);
  if (years.length === 0) return null;
  const sum = years.reduce((a, b) => a + b, 0n);
  return sum / BigInt(years.length);
}

export interface RedemptionQuote {
  pricePerUnit: bigint;
  capRemaining: bigint;
  hurdlePrice: bigint;
  payoutTerm: bigint | null;
  /** Which of the three terms bound the price. */
  boundBy: 'cap' | 'hurdle' | 'payout';
  /** Per-unit tail cap: C_remaining − P_redeem at redemption time. */
  tailCapPerUnit: bigint;
}

export function redemptionQuote(params: {
  capPerUnit: bigint;
  paidPerUnitWad: bigint;
  issuePrice: bigint;
  hurdleWad: bigint;
  payoutMultipleK: bigint;
  settlementTs: number;
  nowTs: number;
  annualGrossPerUnit: bigint[];
}): RedemptionQuote {
  const cRemaining = capRemaining(params.capPerUnit, params.paidPerUnitWad);
  const pHurdle = hurdlePrice(params.issuePrice, params.hurdleWad, params.settlementTs, params.nowTs);
  const dAvg = averageAnnualPayout(params.annualGrossPerUnit);
  const payoutTerm = dAvg === null ? null : params.payoutMultipleK * dAvg;
  const inner = payoutTerm === null ? pHurdle : max(pHurdle, payoutTerm);
  const price = min(cRemaining, inner);
  let boundBy: RedemptionQuote['boundBy'];
  if (price === cRemaining && cRemaining <= inner) boundBy = 'cap';
  else if (payoutTerm !== null && payoutTerm > pHurdle) boundBy = 'payout';
  else boundBy = 'hurdle';
  return { pricePerUnit: price, capRemaining: cRemaining, hurdlePrice: pHurdle, payoutTerm, boundBy, tailCapPerUnit: cRemaining - price };
}

/**
 * Tail clause (C7). For a covered liquidity event reported within 12 months of redemption, holders at
 * redemption receive what they would have been paid, capped per unit at C_remaining − P_redeem.
 */
export function tailPayoutPerUnit(wouldHaveBeenPaidPerUnit: bigint, tailCapPerUnit: bigint, tailPaidPerUnitSoFar: bigint): bigint {
  const room = max(0n, tailCapPerUnit - tailPaidPerUnitSoFar);
  return min(room, max(0n, wouldHaveBeenPaidPerUnit));
}

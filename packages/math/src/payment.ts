/**
 * The quarter's payment in stablecoin, through Stage 1's `paymentUsd` (`@merces/reference` income.ts, SPEC §8).
 *
 * Stage 1's range checks put the offending value in the error message (`assertRange`: "`${name} out of range: ${v}`",
 * `@merces/sdk` bytes.ts). The inputs here are income figures and private terms, which must never reach a log, a
 * queue or an error, so every failure is rethrown as one value-free `RangeError`.
 *
 * Stage 1 refuses `incomeYtd < priorIncomeYtd`; the caller applies the high-water rule (SPEC §1.5: the attested
 * year-to-date figure is `max(real YTD, prior attested YTD)`) before calling.
 */
import { paymentUsd } from '@merces/reference';

export interface PaymentInputs {
  rWad: bigint;
  unitsOutstanding: bigint;
  theta: bigint;
  incomeYtd: bigint;
  priorIncomeYtd: bigint;
  fxAvgWad: bigint;
}

export const PAYMENT_RANGE_ERROR = 'payment inputs out of range';

/** `payment_usd(q) = floor((owed_YTD(incomeYtd) − owed_YTD(priorIncomeYtd)) × fxAvgWad / WAD)`. */
export function paymentStable(a: PaymentInputs): bigint {
  try {
    return paymentUsd({ rWad: a.rWad, unitsOutstanding: a.unitsOutstanding, theta: a.theta, incomeYtd: a.incomeYtd, priorIncomeYtd: a.priorIncomeYtd, fxAvgWad: a.fxAvgWad });
  } catch {
    throw new RangeError(PAYMENT_RANGE_ERROR);
  }
}

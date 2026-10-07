import { WAD, assertNonNegative, mulDiv, wadMul } from './fixed.ts';

/**
 * C6. Cap accounting.
 * Per-unit cap C = m × P0 (m in WAD). Caps count gross payments.
 * The series keeps one accumulator paid_per_unit (gross, WAD-scaled: base units × 1e18).
 */

export function perUnitCap(capMultipleWad: bigint, issuePrice: bigint): bigint {
  assertNonNegative(capMultipleWad, 'capMultiple');
  assertNonNegative(issuePrice, 'issuePrice');
  return wadMul(capMultipleWad, issuePrice);
}

export interface CapResult {
  /** Gross amount accepted into the series. */
  accepted: bigint;
  /** Gross amount refunded to the issuer. */
  refunded: bigint;
  /** New paid_per_unit accumulator (WAD-scaled). */
  paidPerUnitWad: bigint;
  /** True when the cap is reached and the series must be Retired. */
  retired: boolean;
}

/**
 * Apply a gross payment G with N units outstanding.
 *   inc = G / N (WAD-scaled, floored)
 *   if paid_per_unit + inc < C·WAD: accept all of G
 *   else accept only G' = (C·WAD − paid_per_unit) × N / WAD (rounded UP to the base unit so holders
 *   reach exactly the cap; the issuer refund is G − G'), set Retired.
 * Rounding note: inc is floored, so dust (G − inc×N/WAD) stays in the vault and rolls forward (C2).
 */
export function applyGrossPayment(gross: bigint, unitsOutstanding: bigint, paidPerUnitWad: bigint, capPerUnit: bigint): CapResult {
  assertNonNegative(gross, 'gross');
  assertNonNegative(paidPerUnitWad, 'paidPerUnit');
  if (unitsOutstanding <= 0n) throw new RangeError('no units outstanding');
  const capWad = capPerUnit * WAD;
  if (paidPerUnitWad >= capWad) {
    return { accepted: 0n, refunded: gross, paidPerUnitWad, retired: true };
  }
  const incWad = mulDiv(gross, WAD, unitsOutstanding);
  if (paidPerUnitWad + incWad < capWad) {
    return { accepted: gross, refunded: 0n, paidPerUnitWad: paidPerUnitWad + incWad, retired: false };
  }
  const remainingWad = capWad - paidPerUnitWad;
  // G' = remaining × N / WAD, rounded up so that the cap is exactly reached in base units.
  const num = remainingWad * unitsOutstanding;
  let acceptedCapped = num / WAD;
  if (num % WAD !== 0n) acceptedCapped += 1n;
  if (acceptedCapped > gross) acceptedCapped = gross;
  return { accepted: acceptedCapped, refunded: gross - acceptedCapped, paidPerUnitWad: capWad, retired: true };
}

/** Remaining cap per unit in base units (C − paid_per_unit), floored. */
export function capRemaining(capPerUnit: bigint, paidPerUnitWad: bigint): bigint {
  const r = capPerUnit * WAD - paidPerUnitWad;
  return r <= 0n ? 0n : r / WAD;
}

/**
 * Reward-per-share pattern against the NET accumulator (C6).
 *   accNet += net × WAD / N
 *   claimable(holder) = units × accNet / WAD − debt
 * A holder can never claim more than its share; total claims ≤ vault balance because every
 * division floors.
 */
export function accrueNet(accNetWad: bigint, net: bigint, unitsOutstanding: bigint): bigint {
  assertNonNegative(net, 'net');
  if (unitsOutstanding <= 0n) throw new RangeError('no units outstanding');
  return accNetWad + mulDiv(net, WAD, unitsOutstanding);
}

export function claimable(units: bigint, accNetWad: bigint, rewardDebt: bigint): bigint {
  const entitled = mulDiv(units, accNetWad, WAD);
  return entitled > rewardDebt ? entitled - rewardDebt : 0n;
}

/** The debt to record after a holder's position changes, so that past distributions are not re-claimed. */
export function rewardDebt(units: bigint, accNetWad: bigint): bigint {
  return mulDiv(units, accNetWad, WAD);
}

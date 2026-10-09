/**
 * Remaining cap per unit, for display: Stage 1's `C_remaining` (`@merces/reference` redemption.ts,
 * `redemptionQuote`), which rounds the paid amount UP to whole base units, so it never shows more room than the
 * chain will accept.
 */
import { WAD, mulDivCeil } from '@merces/sdk';

/** `max(capPerUnit − ceil(paidPerUnitWad / WAD), 0)`. */
export function capRemaining(capPerUnit: bigint, paidPerUnitWad: bigint): bigint {
  const paidUnits = mulDivCeil(paidPerUnitWad, 1n, WAD);
  return capPerUnit > paidUnits ? capPerUnit - paidUnits : 0n;
}

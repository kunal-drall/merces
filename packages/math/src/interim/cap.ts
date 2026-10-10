/**
 * The interim window and curve cap (S5). The sealed raise uses Stage 1's `walletCapUnitsAtAuction` (re-exported from
 * `@merces/math`), which has no minimum of one; Stage 1's own `walletCapUnits` is the redemption-window cap
 * (`window.ts`) and arrives with Stage 1's window semantics in S5. Until then the transfer window, the curve buy and
 * the services that show their caps use this one.
 */

/** Maximum units one wallet may hold: floor(outstanding × capBps / 10000), at least 1 when outstanding > 0. */
export function walletCapUnits(unitsOutstanding: bigint, capBps: bigint): bigint {
  const cap = (unitsOutstanding * capBps) / 10_000n;
  return cap === 0n && unitsOutstanding > 0n ? 1n : cap;
}

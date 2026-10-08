/**
 * Pyth price normalization and FX pair ids (SPEC §3.1, §6.6).
 */
import { WAD } from "./fixedpoint.js";
import { bytes32, u8 } from "./bytes.js";
import { keccak256 } from "./hash.js";

/**
 * `rate_wad = normalize(price, expo)`: `expo ≤ 0` → `price × 10^(18 + expo)` (requires `expo ≥ −18`);
 * `expo > 0` → `price × 10^18 × 10^expo`.
 */
export function normalizePythPrice(price: bigint, expo: number): bigint {
  if (price <= 0n) throw new RangeError("price must be > 0");
  if (!Number.isInteger(expo)) throw new RangeError("expo must be an integer");
  if (expo <= 0) {
    if (expo < -18) throw new RangeError("expo below −18 is not supported");
    return price * 10n ** BigInt(18 + expo);
  }
  return price * WAD * 10n ** BigInt(expo);
}

/** `rate_wad = floor(WAD × WAD / rate_wad)` */
export function invertRate(rateWad: bigint): bigint {
  if (rateWad <= 0n) throw new RangeError("rate must be > 0");
  return (WAD * WAD) / rateWad;
}

/** `pair_id = keccak256(feed_id ‖ inverted_u8)` — write-once identity of an FX pair. */
export function fxPairId(feedId: Uint8Array | string | bigint, inverted: boolean): Uint8Array {
  return keccak256(bytes32(feedId), u8(inverted ? 1 : 0));
}

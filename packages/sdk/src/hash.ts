import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "./bytes.js";

/** keccak256 — the only hash used on-chain (SPEC §1.3). */
export function keccak256(...parts: Uint8Array[]): Uint8Array {
  return keccak_256(parts.length === 1 ? parts[0]! : concatBytes(...parts));
}

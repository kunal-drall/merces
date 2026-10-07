/**
 * secp256k1 signatures for attestor and report-verifier keys (SPEC §1.4): 65 bytes `r ‖ s ‖ v`
 * with `v ∈ {27, 28}`, low-`s` enforced. Keys are identified by their 20-byte Ethereum-style
 * address `keccak256(pubkey_64)[12..32]`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesEqual, bytesToBigInt, bytesToHex, concatBytes, hexToBytes, utf8, type Hex } from "./bytes.js";
import { keccak256 } from "./hash.js";

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export interface Signature65 {
  r: bigint;
  s: bigint;
  /** 27 or 28 */
  v: 27 | 28;
  /** `r(32) ‖ s(32) ‖ v(1)` */
  bytes: Uint8Array;
}

export function isLowS(s: bigint): boolean {
  return s >= 1n && s <= SECP256K1_HALF_N;
}

function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function toBytes32(v: Uint8Array | string, name: string): Uint8Array {
  const b = typeof v === "string" ? hexToBytes(v) : v;
  if (b.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return b;
}

/** Signs a 32-byte digest. Deterministic (RFC 6979), low-s, recoverable. */
export function signDigest(digest: Uint8Array | string, privateKey: Uint8Array | string): Signature65 {
  const d = toBytes32(digest, "digest");
  const k = toBytes32(privateKey, "privateKey");
  const recovered = secp256k1.sign(d, k, { prehash: false, lowS: true, format: "recovered" });
  // noble's "recovered" layout is recid(1) ‖ r(32) ‖ s(32)
  const recid = recovered[0]!;
  if (recid !== 0 && recid !== 1) throw new Error(`unexpected recovery id ${recid}`);
  const r = bytesToBigInt(recovered.slice(1, 33));
  const s = bytesToBigInt(recovered.slice(33, 65));
  if (!isLowS(s)) throw new Error("signature is not low-s");
  const v = (27 + recid) as 27 | 28;
  return { r, s, v, bytes: concatBytes(be32(r), be32(s), Uint8Array.of(v)) };
}

/** Parses and validates a 65-byte `r ‖ s ‖ v` signature (v ∈ {27,28}, low-s). */
export function parseSignature(sig: Uint8Array | string | Signature65): Signature65 {
  if (!(sig instanceof Uint8Array) && typeof sig !== "string") return sig;
  const b = typeof sig === "string" ? hexToBytes(sig) : sig;
  if (b.length !== 65) throw new RangeError(`signature must be 65 bytes, got ${b.length}`);
  const r = bytesToBigInt(b.slice(0, 32));
  const s = bytesToBigInt(b.slice(32, 64));
  const v = b[64]!;
  if (v !== 27 && v !== 28) throw new RangeError(`invalid v: ${v}`);
  if (r < 1n || r >= SECP256K1_N) throw new RangeError("invalid r");
  if (!isLowS(s)) throw new RangeError("signature is not low-s");
  return { r, s, v, bytes: Uint8Array.from(b) };
}

/** 65-byte uncompressed public key (0x04 ‖ x ‖ y). */
export function publicKeyFromPrivate(privateKey: Uint8Array | string): Uint8Array {
  return secp256k1.getPublicKey(toBytes32(privateKey, "privateKey"), false);
}

/** `keccak256(pubkey_64)[12..32]` from a 65-byte uncompressed or 64-byte raw public key. */
export function addressFromPublicKey(publicKey: Uint8Array): Uint8Array {
  let raw: Uint8Array;
  if (publicKey.length === 65 && publicKey[0] === 0x04) raw = publicKey.slice(1);
  else if (publicKey.length === 64) raw = publicKey;
  else if (publicKey.length === 33) raw = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1);
  else throw new RangeError("unsupported public key encoding");
  return keccak256(raw).slice(12);
}

export function addressFromPrivateKey(privateKey: Uint8Array | string): Uint8Array {
  return addressFromPublicKey(publicKeyFromPrivate(privateKey));
}

/** Recovers the 20-byte signer address; throws on malformed, high-s or unrecoverable signatures. */
export function recoverAddress(digest: Uint8Array | string, sig: Uint8Array | string | Signature65): Uint8Array {
  const d = toBytes32(digest, "digest");
  const parsed = parseSignature(sig);
  const recoverable = concatBytes(Uint8Array.of(parsed.v - 27), be32(parsed.r), be32(parsed.s));
  const pub = secp256k1.recoverPublicKey(recoverable, d, { prehash: false });
  return addressFromPublicKey(pub);
}

/** True when `sig` over `digest` recovers to `expectedAddress` (20 bytes or hex). */
export function verifySignature(digest: Uint8Array | string, sig: Uint8Array | string | Signature65, expectedAddress: Uint8Array | string): boolean {
  const expected = typeof expectedAddress === "string" ? hexToBytes(expectedAddress) : expectedAddress;
  if (expected.length !== 20) throw new RangeError("address must be 20 bytes");
  try {
    return bytesEqual(recoverAddress(digest, sig), expected);
  } catch {
    return false;
  }
}

/** EIP-55 checksummed hex form of a 20-byte address. */
export function toChecksumAddress(address: Uint8Array | string): Hex {
  const b = typeof address === "string" ? hexToBytes(address) : address;
  if (b.length !== 20) throw new RangeError("address must be 20 bytes");
  const lower = bytesToHex(b).slice(2);
  const hash = bytesToHex(keccak256(utf8(lower))).slice(2);
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return `0x${out}`;
}

/**
 * Deterministic TEST private key from a seed string: `keccak256("MERCES_TEST_KEY" ‖ seed)` reduced
 * into `[1, n−1]`. Never use for anything but tests and parity vectors.
 */
export function deriveTestPrivateKey(seed: string | Uint8Array): Uint8Array {
  const s = typeof seed === "string" ? utf8(seed) : seed;
  const k = (bytesToBigInt(keccak256(utf8("MERCES_TEST_KEY"), s)) % (SECP256K1_N - 1n)) + 1n;
  return be32(k);
}

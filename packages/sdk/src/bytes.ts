/**
 * Byte helpers shared by every encoding in the protocol (SPEC §1.3).
 *
 * Integers are big-endian fixed width; 32-byte values are raw; wallets are 32 bytes (a Solana
 * pubkey as-is, an EVM address left-padded with 12 zero bytes).
 */

export type Hex = `0x${string}`;

export const U8_MAX = 0xffn;
export const U16_MAX = 0xffffn;
export const U32_MAX = 0xffff_ffffn;
export const U64_MAX = 0xffff_ffff_ffff_ffffn;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export function toBigInt(v: bigint | number | string, name = "value"): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError(`${name} must be a safe integer`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?(0x[0-9a-fA-F]+|[0-9]+)$/.test(v.trim())) return BigInt(v.trim());
  throw new TypeError(`${name} is not an integer`);
}

export function assertRange(v: bigint, min: bigint, max: bigint, name: string): bigint {
  if (v < min || v > max) throw new RangeError(`${name} out of range: ${v}`);
  return v;
}

export function assertU64(v: bigint | number | string, name = "value"): bigint {
  return assertRange(toBigInt(v, name), 0n, U64_MAX, name);
}

export function assertU128(v: bigint | number | string, name = "value"): bigint {
  return assertRange(toBigInt(v, name), 0n, U128_MAX, name);
}

function beBytes(v: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let x = v;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** 1-byte unsigned integer. */
export function u8(v: bigint | number): Uint8Array {
  return beBytes(assertRange(toBigInt(v, "u8"), 0n, U8_MAX, "u8"), 1);
}
/** 2-byte big-endian unsigned integer. */
export function u16(v: bigint | number): Uint8Array {
  return beBytes(assertRange(toBigInt(v, "u16"), 0n, U16_MAX, "u16"), 2);
}
/** 4-byte big-endian unsigned integer. */
export function u32(v: bigint | number): Uint8Array {
  return beBytes(assertRange(toBigInt(v, "u32"), 0n, U32_MAX, "u32"), 4);
}
/** 8-byte big-endian unsigned integer. */
export function u64(v: bigint | number | string): Uint8Array {
  return beBytes(assertU64(v, "u64"), 8);
}
/** 8-byte big-endian two's-complement signed integer. */
export function i64(v: bigint | number | string): Uint8Array {
  const x = assertRange(toBigInt(v, "i64"), I64_MIN, I64_MAX, "i64");
  return beBytes(x < 0n ? x + (1n << 64n) : x, 8);
}

/**
 * 32 bytes from a bigint (big-endian, must fit), a hex string (must be exactly 32 bytes) or a
 * raw 32-byte array.
 */
export function bytes32(v: bigint | string | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) {
    if (v.length !== 32) throw new RangeError(`expected 32 bytes, got ${v.length}`);
    return Uint8Array.from(v);
  }
  if (typeof v === "string") {
    const b = hexToBytes(v);
    if (b.length !== 32) throw new RangeError(`expected 32 bytes, got ${b.length}`);
    return b;
  }
  return beBytes(assertRange(v, 0n, (1n << 256n) - 1n, "bytes32"), 32);
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** Signed interpretation of an 8-byte big-endian two's-complement value. */
export function bytesToI64(b: Uint8Array): bigint {
  if (b.length !== 8) throw new RangeError("expected 8 bytes");
  const u = bytesToBigInt(b);
  return u > I64_MAX ? u - (1n << 64n) : u;
}

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 === 1) h = "0" + h;
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new TypeError(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): Hex {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return `0x${s}`;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------------------------
// Wallets (32 bytes on both chains)
// ---------------------------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes a base58 string (Bitcoin alphabet, as Solana uses) into bytes. */
export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let v = 0n;
  for (const c of s) {
    const d = BASE58_ALPHABET.indexOf(c);
    if (d < 0) throw new TypeError(`invalid base58 character '${c}'`);
    v = v * 58n + BigInt(d);
  }
  let leading = 0;
  while (leading < s.length && s[leading] === "1") leading++;
  const body: number[] = [];
  while (v > 0n) {
    body.push(Number(v & 0xffn));
    v >>= 8n;
  }
  body.reverse();
  return concatBytes(new Uint8Array(leading), Uint8Array.from(body));
}

export function base58Encode(bytes: Uint8Array): string {
  let v = bytesToBigInt(bytes);
  let out = "";
  while (v > 0n) {
    out = BASE58_ALPHABET[Number(v % 58n)] + out;
    v /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  return "1".repeat(leading) + out;
}

/** A Solana pubkey (32 raw bytes or a base58 string) as the 32-byte wallet value. */
export function walletFromSolanaPubkey(pubkey: Uint8Array | string): Uint8Array {
  const b = typeof pubkey === "string" ? base58Decode(pubkey) : Uint8Array.from(pubkey);
  if (b.length !== 32) throw new RangeError(`Solana pubkey must be 32 bytes, got ${b.length}`);
  return b;
}

/** An EVM address (20 bytes, hex with or without 0x) left-padded with 12 zero bytes. */
export function walletFromEvmAddress(address: string | Uint8Array): Uint8Array {
  const b = typeof address === "string" ? hexToBytes(address) : Uint8Array.from(address);
  if (b.length !== 20) throw new RangeError(`EVM address must be 20 bytes, got ${b.length}`);
  return concatBytes(new Uint8Array(12), b);
}

/** Inverse of {@link walletFromEvmAddress}; throws when the padding is not zero. */
export function evmAddressFromWallet(wallet: Uint8Array): Hex {
  if (wallet.length !== 32) throw new RangeError("wallet must be 32 bytes");
  for (let i = 0; i < 12; i++) if (wallet[i] !== 0) throw new RangeError("wallet is not a padded EVM address");
  return bytesToHex(wallet.slice(12));
}

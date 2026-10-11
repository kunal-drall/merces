import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SECP256K1_N, addressFromPrivateKey, keccak256, signDigest, toChecksumAddress, verifySignature } from '@merces/math';
import { signature65Hex } from '@merces/domain';

/**
 * The attestor's key on the attestor's own machine (S4 D2: no custody; the backend never holds, receives or rebuilds
 * it). A dedicated secp256k1 key, never funded and never imported into a wallet: it signs Stage 1's raw `MERCES_*`
 * digests, and a raw-digest signer would sign any 32 bytes, a transaction hash included.
 *
 * It is kept in a Web3 Secret Storage v3 keystore (the format geth, Foundry's `cast` and most Ethereum tools read):
 *  - the key is derived from the password with scrypt (`@noble/hashes`), at go-ethereum's standard strength
 *    (`StandardScryptN` = 2^18, r = 8, `StandardScryptP` = 1, dklen 32; VERSIONS.md "Attestor device tool");
 *  - the 32-byte private key is encrypted with AES-128-CTR (`node:crypto`) under `DK[0..16]` and a random 16-byte IV;
 *  - the MAC is `keccak256(DK[16..32] ‖ ciphertext)` (Stage 1's keccak256 through `@merces/math`), checked in constant
 *    time before anything is decrypted.
 *
 * No production path makes a weak keystore (S4 amendment fix 4): a keystore this tool writes has scrypt `n` of at least
 * 2^18, and only the test harness (`VITEST=true` or `NODE_ENV=test`) may lower it, to keep tests fast. This tool uses a
 * keystore below that strength only as the source of an `import`, which re-encrypts the key at full strength.
 *
 * Nothing here prints, logs or returns the private key: `AttestorKey` shows its address only, errors name no password
 * and no key, and the key bytes stay inside this module (`signDigestWith` is for the signer module; the package index
 * does not export it).
 */

// ---------------------------------------------------------------- parameters

/** go-ethereum `StandardScryptN` (1 << 18: "256MB memory and approximately 1s CPU time"), the scrypt `n` this tool writes. */
export const KEYSTORE_SCRYPT_N = 1 << 18;
/** go-ethereum `scryptR`. */
export const KEYSTORE_SCRYPT_R = 8;
/** go-ethereum `StandardScryptP`. */
export const KEYSTORE_SCRYPT_P = 1;
/** The derived key's length (go-ethereum `scryptDKLen`): 16 bytes of AES key, 16 bytes of MAC key. */
export const KEYSTORE_DKLEN = 32;
/** The weakest scrypt `n` this tool writes or signs with, outside the test harness: the standard value. */
export const MIN_KEYSTORE_SCRYPT_N = KEYSTORE_SCRYPT_N;
/** Upper bounds on a keystore's KDF parameters, so a hostile file cannot exhaust memory or time (n 2^20, r·p 64: 1 GiB at most). */
const MAX_SCRYPT_N = 1 << 20;
const MAX_SCRYPT_RP = 64;
const MAX_PBKDF2_C = 10_000_000;
/** A new keystore's password: at least this many characters (never echoed, never stored). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * True only under the test harness: vitest sets `VITEST=true`, and `NODE_ENV=test` is the conventional marker. The one
 * thing it changes is the scrypt `n` a keystore may be written and used with (tests run at n = 2^4 or so).
 */
export function isTestHarness(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test';
}

// ---------------------------------------------------------------- errors

export type KeystoreErrorCode = 'malformed' | 'unsupported' | 'weak-kdf' | 'wrong-password' | 'address-mismatch' | 'invalid-key' | 'weak-password';

/** A refusal of the keystore module. Its message names no password, key or derived key. */
export class KeystoreError extends Error {
  constructor(
    public readonly code: KeystoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KeystoreError';
  }
}

// ---------------------------------------------------------------- the key

const secrets = new WeakMap<AttestorKey, Uint8Array>();

function hexOf(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/**
 * A secp256k1 attestor key in memory. It shows its 20-byte address and nothing else (`toJSON`, `toString` and
 * `util.inspect` print the address), so it cannot reach a log or a JSON body by accident.
 */
export class AttestorKey {
  /** the key's 20-byte address: 0x + 40 lowercase hex (the canonical model's form) */
  readonly address: string;

  private constructor(key: Uint8Array) {
    this.address = '0x' + hexOf(addressFromPrivateKey(key));
    secrets.set(this, key);
  }

  /** A key from its 32 bytes (a scalar in [1, n − 1]; a copy is kept). */
  static fromPrivateKey(key: Uint8Array): AttestorKey {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new KeystoreError('invalid-key', 'a private key is 32 bytes');
    const k = BigInt('0x' + hexOf(key));
    if (k < 1n || k >= SECP256K1_N) throw new KeystoreError('invalid-key', 'the private key is not a secp256k1 scalar in [1, n − 1]');
    return new AttestorKey(Uint8Array.from(key));
  }

  /** A fresh key from the operating system's CSPRNG (`crypto.randomBytes`), rejection-sampled into [1, n − 1]. */
  static generate(): AttestorKey {
    for (;;) {
      const r = randomBytes(32);
      const b = new Uint8Array(r);
      r.fill(0);
      const k = BigInt('0x' + hexOf(b));
      if (k >= 1n && k < SECP256K1_N) return new AttestorKey(b);
      b.fill(0);
    }
  }

  /** The EIP-55 form of the address, for display only. */
  get checksumAddress(): string {
    return toChecksumAddress(this.address);
  }

  /** Best effort: overwrites the key bytes in memory and makes this object unusable. */
  wipe(): void {
    const k = secrets.get(this);
    if (k) k.fill(0);
    secrets.delete(this);
  }

  toJSON(): { address: string } {
    return { address: this.address };
  }

  toString(): string {
    return `AttestorKey(${this.address})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function keyBytes(key: AttestorKey): Uint8Array {
  const k = secrets.get(key);
  if (!k) throw new KeystoreError('invalid-key', 'this key was wiped');
  return k;
}

/**
 * Signs a 32-byte digest with Stage 1's `signDigest` (RFC 6979, low `s`, `v ∈ {27, 28}`) and checks that the signature
 * recovers to the key's address before returning it (lowercase `0x` + 130 hex). For `attestor-signer.ts` only, which
 * calls it on a digest it rebuilt itself (a Stage 1 message from typed fields, or an EIP-191 link challenge it checked);
 * the package index does not export it.
 */
export function signDigestWith(key: AttestorKey, digest: Uint8Array): string {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new RangeError('a digest is 32 bytes');
  const sig = signDigest(digest, keyBytes(key));
  if (!verifySignature(digest, sig.bytes, key.address)) throw new Error('the signature does not recover to the key (refused)');
  return signature65Hex(sig);
}

// ---------------------------------------------------------------- the keystore (Web3 Secret Storage v3)

export interface ScryptParams {
  dklen: number;
  n: number;
  p: number;
  r: number;
  salt: string;
}
export interface Pbkdf2Params {
  c: number;
  dklen: number;
  prf: 'hmac-sha256';
  salt: string;
}

/** A Web3 Secret Storage v3 keystore, as go-ethereum writes it (the address without `0x`, lowercase). */
export interface KeystoreV3 {
  address?: string;
  crypto: {
    cipher: 'aes-128-ctr';
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: 'scrypt' | 'pbkdf2';
    kdfparams: ScryptParams | Pbkdf2Params;
    mac: string;
  };
  id: string;
  version: 3;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}
function hexField(v: unknown, what: string, opts: { len?: number; min?: number; max?: number } = {}): Uint8Array {
  if (typeof v !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(v)) throw new KeystoreError('malformed', `the keystore's ${what} is not hex`);
  const b = new Uint8Array(Buffer.from(v.replace(/^0x/, ''), 'hex'));
  if (opts.len !== undefined && b.length !== opts.len) throw new KeystoreError('malformed', `the keystore's ${what} is not ${opts.len} bytes`);
  if (opts.min !== undefined && b.length < opts.min) throw new KeystoreError('malformed', `the keystore's ${what} is shorter than ${opts.min} bytes`);
  if (opts.max !== undefined && b.length > opts.max) throw new KeystoreError('malformed', `the keystore's ${what} is longer than ${opts.max} bytes`);
  return b;
}
function intField(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new KeystoreError('malformed', `the keystore's ${what} is not a positive integer`);
  return v;
}

function aes128ctr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-128-ctr', key, iv);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}
function aes128ctrDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const d = createDecipheriv('aes-128-ctr', key, iv);
  return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
}
function macOf(dk: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return keccak256(dk.slice(16, 32), ciphertext);
}
function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

/**
 * Encrypts `key` under `password` into a new Web3 Secret Storage v3 keystore: scrypt at `opts.scryptN` (default
 * 2^18), r = 8, p = 1, a fresh 32-byte salt, a fresh 16-byte IV and a random UUID. A `scryptN` below 2^18 is refused
 * (`weak-kdf`) outside the test harness; a password shorter than 8 characters is refused (`weak-password`).
 */
export async function createKeystore(key: AttestorKey, password: string, opts: { scryptN?: number; env?: Readonly<Record<string, string | undefined>> } = {}): Promise<KeystoreV3> {
  const n = opts.scryptN ?? KEYSTORE_SCRYPT_N;
  if (!isPowerOfTwo(n) || n > MAX_SCRYPT_N) throw new KeystoreError('unsupported', `scrypt n must be a power of two between 2 and ${MAX_SCRYPT_N}`);
  if (n < MIN_KEYSTORE_SCRYPT_N && !isTestHarness(opts.env)) {
    throw new KeystoreError('weak-kdf', `refusing to write a keystore with scrypt n below ${MIN_KEYSTORE_SCRYPT_N} (the Web3 Secret Storage standard strength); a lower n is for the test harness only`);
  }
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) throw new KeystoreError('weak-password', `a keystore password has at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = new Uint8Array(randomBytes(32));
  const iv = new Uint8Array(randomBytes(16));
  const dk = await scryptAsync(utf8(password), salt, { N: n, r: KEYSTORE_SCRYPT_R, p: KEYSTORE_SCRYPT_P, dkLen: KEYSTORE_DKLEN });
  try {
    const ciphertext = aes128ctr(dk.slice(0, 16), iv, keyBytes(key));
    return {
      address: key.address.slice(2),
      crypto: {
        cipher: 'aes-128-ctr',
        ciphertext: hexOf(ciphertext),
        cipherparams: { iv: hexOf(iv) },
        kdf: 'scrypt',
        kdfparams: { dklen: KEYSTORE_DKLEN, n, p: KEYSTORE_SCRYPT_P, r: KEYSTORE_SCRYPT_R, salt: hexOf(salt) },
        mac: hexOf(macOf(dk, ciphertext)),
      },
      id: randomUUID(),
      version: 3,
    };
  } finally {
    dk.fill(0);
  }
}

/** The KDF of a keystore as this tool reads it (for messages and checks; no secret). */
export interface KeystoreKdf {
  kdf: 'scrypt' | 'pbkdf2';
  /** scrypt `n`, or the PBKDF2 iteration count */
  cost: number;
}

/**
 * Decrypts a Web3 Secret Storage v3 keystore (an object or its JSON text) with `password`. The MAC is checked first, in
 * constant time (`wrong-password` on a mismatch, which is also what a tampered ciphertext or MAC gives). A key shorter
 * than 32 bytes (old go-ethereum keystores dropped leading zero bytes) is left-padded. An `address` field, when
 * present, must be the key's (`address-mismatch`).
 *
 * By default the keystore must be one this tool would write: scrypt with `n` ≥ 2^18 (any `n` ≥ 2 under the test
 * harness), else `weak-kdf`. `allowWeakKdf` reads any scrypt or PBKDF2-HMAC-SHA256 keystore within sane bounds: only
 * `import` uses it, for the source it re-encrypts at full strength.
 */
export async function decryptKeystore(input: unknown, password: string, opts: { allowWeakKdf?: boolean; env?: Readonly<Record<string, string | undefined>> } = {}): Promise<AttestorKey> {
  let ks: unknown = input;
  if (typeof input === 'string') {
    try {
      ks = JSON.parse(input);
    } catch {
      throw new KeystoreError('malformed', 'the keystore is not JSON');
    }
  }
  if (typeof ks !== 'object' || ks === null || Array.isArray(ks)) throw new KeystoreError('malformed', 'the keystore is not a JSON object');
  const o = ks as Record<string, unknown>;
  if (o.version !== 3) throw new KeystoreError('unsupported', 'only Web3 Secret Storage version 3 keystores are supported');
  const c = (o.crypto ?? o.Crypto) as Record<string, unknown> | undefined;
  if (typeof c !== 'object' || c === null) throw new KeystoreError('malformed', 'the keystore has no crypto section');
  if (c.cipher !== 'aes-128-ctr') throw new KeystoreError('unsupported', 'the keystore\'s cipher is not aes-128-ctr');
  const cp = c.cipherparams as Record<string, unknown> | undefined;
  const iv = hexField(cp?.iv, 'cipherparams.iv', { len: 16 });
  const ciphertext = hexField(c.ciphertext, 'ciphertext', { min: 1, max: 32 });
  const mac = hexField(c.mac, 'mac', { len: 32 });
  const kp = c.kdfparams as Record<string, unknown> | undefined;
  if (typeof kp !== 'object' || kp === null) throw new KeystoreError('malformed', 'the keystore has no kdfparams');
  const salt = hexField(kp.salt, 'kdfparams.salt', { min: 16, max: 64 });
  const dklen = intField(kp.dklen, 'kdfparams.dklen');
  if (dklen < 32 || dklen > 64) throw new KeystoreError('unsupported', 'the keystore\'s dklen is not between 32 and 64');
  const minN = isTestHarness(opts.env) ? 2 : MIN_KEYSTORE_SCRYPT_N;
  const weak = (what: string) => new KeystoreError('weak-kdf', `this keystore's KDF (${what}) is below the tool's minimum (scrypt n ≥ ${MIN_KEYSTORE_SCRYPT_N}); re-encrypt it with \`merces-attestor import\``);
  let dk: Uint8Array;
  if (c.kdf === 'scrypt') {
    const n = intField(kp.n, 'kdfparams.n');
    const r = intField(kp.r, 'kdfparams.r');
    const p = intField(kp.p, 'kdfparams.p');
    if (!isPowerOfTwo(n) || n > MAX_SCRYPT_N || r * p > MAX_SCRYPT_RP) throw new KeystoreError('unsupported', `the keystore's scrypt parameters are out of bounds (n a power of two ≤ ${MAX_SCRYPT_N}, r·p ≤ ${MAX_SCRYPT_RP})`);
    if (!opts.allowWeakKdf && n < minN) throw weak(`scrypt n = ${n}`);
    dk = await scryptAsync(utf8(password), salt, { N: n, r, p, dkLen: dklen });
  } else if (c.kdf === 'pbkdf2') {
    if (kp.prf !== 'hmac-sha256') throw new KeystoreError('unsupported', 'the keystore\'s PBKDF2 prf is not hmac-sha256');
    const iterations = intField(kp.c, 'kdfparams.c');
    if (iterations > MAX_PBKDF2_C) throw new KeystoreError('unsupported', `the keystore's PBKDF2 iteration count is above ${MAX_PBKDF2_C}`);
    if (!opts.allowWeakKdf) throw weak('PBKDF2');
    dk = await pbkdf2Async(sha256, utf8(password), salt, { c: iterations, dkLen: dklen });
  } else {
    throw new KeystoreError('unsupported', 'the keystore\'s KDF is neither scrypt nor pbkdf2');
  }
  try {
    const expected = Buffer.from(macOf(dk, ciphertext));
    if (!timingSafeEqual(expected, Buffer.from(mac))) throw new KeystoreError('wrong-password', 'wrong password, or the keystore was altered (its MAC does not match)');
    const plain = aes128ctrDecrypt(dk.slice(0, 16), iv, ciphertext);
    const padded = new Uint8Array(32);
    padded.set(plain, 32 - plain.length);
    plain.fill(0);
    const key = AttestorKey.fromPrivateKey(padded);
    padded.fill(0);
    if (o.address !== undefined) {
      const a = typeof o.address === 'string' ? o.address.toLowerCase().replace(/^0x/, '') : '';
      if (`0x${a}` !== key.address) {
        key.wipe();
        throw new KeystoreError('address-mismatch', 'the keystore\'s address field is not its key\'s address');
      }
    }
    return key;
  } finally {
    dk.fill(0);
  }
}

/** A keystore's KDF and cost, read without the password (for messages). Null when the file is not a v3 keystore. */
export function keystoreKdf(input: unknown): KeystoreKdf | null {
  const o = input as { crypto?: { kdf?: unknown; kdfparams?: { n?: unknown; c?: unknown } }; Crypto?: { kdf?: unknown; kdfparams?: { n?: unknown; c?: unknown } } } | null;
  const c = o?.crypto ?? o?.Crypto;
  if (c?.kdf === 'scrypt' && typeof c.kdfparams?.n === 'number') return { kdf: 'scrypt', cost: c.kdfparams.n };
  if (c?.kdf === 'pbkdf2' && typeof c.kdfparams?.c === 'number') return { kdf: 'pbkdf2', cost: c.kdfparams.c };
  return null;
}

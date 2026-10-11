import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import type { DigestSigner } from '@merces/domain';
import { addressFromPrivateKey, publicKeyFromPrivate, signDigest as stage1SignDigest, verifySignature } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { KmsKeyError, digestBytes } from './kms-secp256k1.ts';

/**
 * Key-management port. Signing keys never enter the repository: production uses a cloud KMS behind this interface;
 * development uses deterministic keys derived from a dev seed (never for real funds, refused next to any live chain:
 * `resolveSecret`, A-REV-9).
 *
 * Two algorithms, each with its own methods (S4 WP3):
 * - **ed25519** (`sign`): Solana transaction signers (the keeper's fee payer). `sign` signs the message bytes as ed25519
 *   does (no prehash) and refuses a secp256k1 key. (The report verifier's key moved to secp256k1 in S4 WP6, and with it
 *   the SPKI export its ed25519 key needed.)
 * - **secp256k1** (`signerAddress`, `signDigest`): Stage 1's signature keys (SPEC v1.1.2 §1.4). `signDigest` signs a
 *   32-byte digest as it is (no hashing, no EIP-191 prefix) and returns Stage 1's 65 bytes `r ‖ s ‖ v` (low `s`,
 *   `v ∈ {27, 28}`) as lowercase `0x` + 130 hex, after checking that the signature recovers to `signerAddress`
 *   (Stage 1's `verifySignature`): a signature that does not is never returned (fail closed). It refuses an ed25519 key.
 *
 * A key's algorithm is configuration, never inferred from its id; an unknown key id is an error. No route ever signs a
 * digest a caller supplies: whoever calls `signDigest` built the digest from typed fields and checked the signing
 * domain against the network allow-list first (`assertSigningNetwork`, `@merces/domain` signing.ts), so no key behind
 * this port signs for a mainnet. EVM transactions (yParity 0/1) are not signed through `signDigest`.
 */
export type KeyAlgorithm = 'ed25519' | 'secp256k1';

export interface KmsPort {
  readonly provider: string;
  /** hex-encoded public key (no `0x`): ed25519 → 32 raw bytes; secp256k1 → 65-byte uncompressed `04 ‖ X ‖ Y` */
  publicKey(keyId: string): Promise<{ algorithm: KeyAlgorithm; publicKeyHex: string }>;
  /** ed25519 only: the raw 64-byte signature over `message`, hex (no `0x`); throws on a secp256k1 key */
  sign(keyId: string, message: Uint8Array): Promise<string>;
  /** secp256k1 only: the key's 20-byte address, lowercase `0x` + 40 hex; throws on an ed25519 key */
  signerAddress(keyId: string): Promise<string>;
  /**
   * secp256k1 only: Stage 1's signature over the 32-byte `digest` (`0x` + 64 hex, or bytes) as it is: lowercase `0x` +
   * 130 hex `r ‖ s ‖ v`, low `s`, `v ∈ {27, 28}`, verified to recover to `signerAddress(keyId)` before it is returned;
   * throws (`KmsKeyError`) otherwise, and on an ed25519 key or a malformed digest
   */
  signDigest(keyId: string, digest: string | Uint8Array): Promise<string>;
}

/** A secp256k1 key behind a `KmsPort` as a `DigestSigner` (`@merces/domain`): its address is read once, here. */
export async function kmsDigestSigner(kms: KmsPort, keyId: string): Promise<DigestSigner> {
  const address = await kms.signerAddress(keyId);
  return { address, signDigest: (digest: string) => kms.signDigest(keyId, digest) };
}

/** A raw 32-byte ed25519 public key as DER SubjectPublicKeyInfo (RFC 8410), what node:crypto imports (Solana wallet sign-in). */
export function ed25519RawToSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]);
}

const ALGORITHMS: readonly KeyAlgorithm[] = ['ed25519', 'secp256k1'];

/**
 * Local dev signer (`MERCES_KMS_PROVIDER=local`). Deterministic, so restarts keep the same keys; anyone who knows the
 * seed knows every key, so the services and the report verifier accept the published dev seed only while every chain
 * is the simulator (`resolveSecret`).
 *
 * Each key id is configured with its algorithm (`algorithms`); any other key id is refused.
 * - ed25519: the seed is `sha256("merces-local-kms:" ‖ seed ‖ ":" ‖ keyId)`.
 * - secp256k1: Stage 1's test-key derivation over the same string (`deriveTestPrivateKey`, `@merces/math/testing`:
 *   `keccak256("MERCES_TEST_KEY" ‖ s) mod (n − 1) + 1`, so the key is in [1, n − 1]); signing is Stage 1's
 *   `signDigest` (RFC 6979, low `s`), checked against the key's address before it is returned.
 */
export class LocalKms implements KmsPort {
  readonly provider = 'local';
  private readonly algorithms: ReadonlyMap<string, KeyAlgorithm>;
  private readonly cache = new Map<string, { algorithm: 'ed25519'; ed: KeyObject } | { algorithm: 'secp256k1'; secp: Uint8Array; address: string }>();
  constructor(private readonly seed: string, algorithms: Readonly<Record<string, KeyAlgorithm>>) {
    const map = new Map<string, KeyAlgorithm>();
    for (const [keyId, algorithm] of Object.entries(algorithms ?? {})) {
      if (!ALGORITHMS.includes(algorithm)) throw new KmsKeyError('wrong-algorithm', `LocalKms: key "${keyId}" has no known algorithm (ed25519 or secp256k1)`);
      map.set(keyId, algorithm);
    }
    this.algorithms = map;
  }

  private material(keyId: string) {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    const algorithm = this.algorithms.get(keyId);
    if (!algorithm) throw new KmsKeyError('unknown-key', `LocalKms: key "${keyId}" is not configured (each key id is given its algorithm explicitly)`);
    const label = `merces-local-kms:${this.seed}:${keyId}`;
    let m;
    if (algorithm === 'ed25519') {
      // PKCS#8 wrapper for a raw ed25519 seed
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(label).digest()]);
      m = { algorithm, ed: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) } as const;
    } else {
      const secp = deriveTestPrivateKey(label);
      m = { algorithm, secp, address: '0x' + Buffer.from(addressFromPrivateKey(secp)).toString('hex') } as const;
    }
    this.cache.set(keyId, m);
    return m;
  }

  private secp(keyId: string, what: string) {
    const m = this.material(keyId);
    if (m.algorithm !== 'secp256k1') throw new KmsKeyError('wrong-algorithm', `key "${keyId}" is ed25519: ${what} is secp256k1 only`);
    return m;
  }

  private ed(keyId: string, what: string) {
    const m = this.material(keyId);
    if (m.algorithm !== 'ed25519') throw new KmsKeyError('wrong-algorithm', `key "${keyId}" is secp256k1: ${what} is ed25519 only${what === 'sign()' ? ' (use signDigest)' : ''}`);
    return m;
  }

  async publicKey(keyId: string): Promise<{ algorithm: KeyAlgorithm; publicKeyHex: string }> {
    const m = this.material(keyId);
    if (m.algorithm === 'ed25519') {
      const spki = createPublicKey(m.ed).export({ format: 'der', type: 'spki' }) as Buffer;
      return { algorithm: 'ed25519', publicKeyHex: spki.subarray(spki.length - 32).toString('hex') };
    }
    return { algorithm: 'secp256k1', publicKeyHex: Buffer.from(publicKeyFromPrivate(m.secp)).toString('hex') };
  }

  async sign(keyId: string, message: Uint8Array): Promise<string> {
    return edSign(null, Buffer.from(message), this.ed(keyId, 'sign()').ed).toString('hex');
  }

  async signerAddress(keyId: string): Promise<string> {
    return this.secp(keyId, 'signerAddress()').address;
  }

  async signDigest(keyId: string, digest: string | Uint8Array): Promise<string> {
    const m = this.secp(keyId, 'signDigest()');
    const d = digestBytes(digest);
    const sig = stage1SignDigest(d, m.secp);
    if (!verifySignature(d, sig.bytes, m.address)) throw new KmsKeyError('self-check', `key "${keyId}": the signature does not recover to the key's address`);
    return '0x' + Buffer.from(sig.bytes).toString('hex');
  }
}

export function generateEd25519(): { privateKeyPem: string; publicKeyRawHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKeyRawHex: spki.subarray(spki.length - 32).toString('hex') };
}

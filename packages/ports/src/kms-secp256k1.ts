import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SECP256K1_N, addressFromPublicKey, isLowS, verifySignature } from '@merces/math';
import type { KeyAlgorithm, KmsPort } from './kms.ts';

/**
 * secp256k1 keys held by a cloud KMS, in Stage 1's signature format (SPEC v1.1.2 §1.4; S4 WP3, D10, A-SIG-5).
 *
 * Stage 1 signs a 32-byte keccak digest as it is (no hashing, no EIP-191 prefix) and takes 65 bytes `r ‖ s ‖ v`,
 * `v ∈ {27, 28}`, low `s`: Solana's `parse_signature` refuses anything else, and the EVM's `tryRecover` recovers a
 * non-canonical signature to nobody. A cloud KMS returns something else:
 *
 * - **DER**, not `r ‖ s ‖ v` (AWS `Sign` with `ECDSA_SHA_256`; GCP `AsymmetricSign`): `signature65FromDer` parses it
 *   strictly (noble's DER decoder: minimal lengths, no leading zeros, no trailing bytes, `r`, `s` in [1, n−1]);
 * - **any `s`**: no vendor source we could read promises low `s` (VERSIONS.md "Signing keys and KMS"), so a high `s`
 *   becomes `n − s` (the same signature, the other half of the curve; the recovery bit flips with it);
 * - **no recovery id**: the normaliser tries `v = 27` and `v = 28` through Stage 1's own `verifySignature` (Stage 1's
 *   `recoverAddress` and the 20-byte compare) and keeps the one that recovers the key's address, so the result is
 *   self-verified by construction; neither fitting (a wrong key, or `r ≥ p − n`, which `v` cannot express) fails
 *   closed;
 * - **the public key as DER SubjectPublicKeyInfo** (AWS `GetPublicKey`; GCP `GetPublicKey` with `public_key_format`
 *   DER, or its default PEM through `spkiFromPem`): `addressFromSpki` accepts only secp256k1's SPKI and gives the key's
 *   20-byte address through Stage 1's `addressFromPublicKey`.
 *
 * Nothing here re-implements an encoding: the digest, the address and the signature check are Stage 1's (through
 * `@merces/math`); noble is used only to parse DER and to write the 64-byte `r ‖ s` it decoded.
 *
 * `RemoteSecp256k1Kms` is the provider-neutral adapter: a concrete AWS or GCP client supplies two calls and gets a
 * `KmsPort`. Which provider holds the report-verifier key is an owner question (STAGE1_INTEGRATION.md "Owner decisions
 * and questions", S4 question 1); until it is answered the report verifier refuses any `MERCES_KMS_PROVIDER` but
 * `local` (`report-verifier/src/main.ts`), and the services hold only the local dev signer.
 *
 * No route ever signs a digest a caller supplies: a `signDigest` caller builds the digest itself from typed fields
 * (the report verifier: Stage 1's `reportAttestationMessage`, S4 WP6), after checking the signing domain against the
 * network allow-list (`assertSigningNetwork`, `@merces/domain` signing.ts), so no key here ever signs for a mainnet.
 */

/** secp256k1's DER SubjectPublicKeyInfo prefix (id-ecPublicKey, secp256k1, a 66-byte BIT STRING): 23 bytes. */
export const SECP256K1_SPKI_PREFIX_HEX = '3056301006072a8648ce3d020106052b8104000a034200';
/** A secp256k1 SPKI: the prefix and the 65-byte uncompressed point `0x04 ‖ X ‖ Y`. */
export const SECP256K1_SPKI_LENGTH = 88;

export type KmsKeyErrorCode =
  | 'unknown-key' | 'wrong-algorithm' | 'malformed-digest' | 'malformed-signature' | 'malformed-public-key' | 'no-recovery' | 'self-check';

/**
 * A KMS refusal. Messages name the key id and the reason, never a seed, a private key or a provider credential (a
 * digest and a signature are not secret, but the messages carry neither).
 */
export class KmsKeyError extends Error {
  constructor(
    public readonly code: KmsKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KmsKeyError';
  }
}

const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');

/** A 32-byte digest from `0x` + 64 hex (any case) or 32 bytes; anything else is refused. */
export function digestBytes(digest: string | Uint8Array): Uint8Array {
  if (digest instanceof Uint8Array) {
    if (digest.length !== 32) throw new KmsKeyError('malformed-digest', 'a digest must be 32 bytes');
    return Uint8Array.from(digest);
  }
  if (typeof digest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new KmsKeyError('malformed-digest', 'a digest must be 0x + 64 hex');
  return Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
}

function addressOf(expectedAddress: string): string {
  if (typeof expectedAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(expectedAddress)) throw new KmsKeyError('malformed-public-key', 'the expected signer address must be 0x + 40 hex');
  return expectedAddress.toLowerCase();
}

/**
 * Stage 1's 65-byte signature from an `(r, s)` pair a KMS produced over `digest` with the key at `expectedAddress`:
 * `s` normalised to low `s`, then `v ∈ {27, 28}` chosen by Stage 1's own recovery. Returns lowercase `0x` + 130 hex,
 * which recovers to `expectedAddress` (checked); throws `KmsKeyError('no-recovery')` when neither `v` does.
 */
export function signature65FromRs(r: bigint, s: bigint, digest: string | Uint8Array, expectedAddress: string): string {
  const d = digestBytes(digest);
  const address = addressOf(expectedAddress);
  let sig;
  try {
    sig = new secp256k1.Signature(r, isLowS(s) ? s : SECP256K1_N - s); // validates r and s in [1, n − 1]
  } catch {
    throw new KmsKeyError('malformed-signature', 'the signature\'s r or s is out of range');
  }
  const rs = sig.toBytes('compact');
  for (const v of [27, 28]) {
    const candidate = new Uint8Array(65);
    candidate.set(rs);
    candidate[64] = v;
    // Stage 1's check: parseSignature (v, r range, low s), recoverAddress (keccak of the recovered key), the compare
    if (verifySignature(d, candidate, address)) return hex(candidate);
  }
  throw new KmsKeyError('no-recovery', 'the signature recovers to neither v = 27 nor v = 28 for the key\'s address (a wrong key, or an r the format cannot carry)');
}

/**
 * Stage 1's 65-byte signature from a DER ECDSA signature (ANSI X9.62, RFC 3279 §2.2.3) a KMS produced over `digest`
 * with the key at `expectedAddress`. Strict DER, high `s` accepted and normalised, the recovery id found by trial;
 * fails closed (`KmsKeyError`) on malformed DER and when the result does not recover to the address.
 */
export function signature65FromDer(der: Uint8Array, digest: string | Uint8Array, expectedAddress: string): string {
  if (!(der instanceof Uint8Array)) throw new KmsKeyError('malformed-signature', 'a DER signature must be bytes');
  let parsed;
  try {
    parsed = secp256k1.Signature.fromBytes(der, 'der');
  } catch {
    throw new KmsKeyError('malformed-signature', 'not a DER ECDSA signature');
  }
  return signature65FromRs(parsed.r, parsed.s, digest, expectedAddress);
}

/** The 65-byte uncompressed point (`0x04 ‖ X ‖ Y`) of a secp256k1 SPKI; refuses any other key type or a point off the curve. */
export function publicKeyFromSpki(spki: Uint8Array): Uint8Array {
  if (!(spki instanceof Uint8Array) || spki.length !== SECP256K1_SPKI_LENGTH || Buffer.from(spki.subarray(0, 23)).toString('hex') !== SECP256K1_SPKI_PREFIX_HEX) {
    throw new KmsKeyError('malformed-public-key', 'not a secp256k1 SubjectPublicKeyInfo (88 bytes with the id-ecPublicKey/secp256k1 prefix)');
  }
  const point = Uint8Array.from(spki.subarray(23));
  if (point[0] !== 0x04) throw new KmsKeyError('malformed-public-key', 'the SubjectPublicKeyInfo\'s point is not uncompressed');
  try {
    secp256k1.Point.fromBytes(point).assertValidity();
  } catch {
    throw new KmsKeyError('malformed-public-key', 'the SubjectPublicKeyInfo\'s point is not on secp256k1');
  }
  return point;
}

/** A secp256k1 key's 20-byte address (lowercase `0x` + 40 hex) from its DER SubjectPublicKeyInfo, through Stage 1's `addressFromPublicKey`. */
export function addressFromSpki(spki: Uint8Array): string {
  return hex(addressFromPublicKey(publicKeyFromSpki(spki)));
}

/** The DER bytes of a PEM `PUBLIC KEY` block (GCP Cloud KMS returns PEM by default; RFC 7468 §13). */
export function spkiFromPem(pem: string): Uint8Array {
  const m = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END PUBLIC KEY-----\s*$/.exec(typeof pem === 'string' ? pem.trim() : '');
  if (!m) throw new KmsKeyError('malformed-public-key', 'not a PEM PUBLIC KEY block');
  return Uint8Array.from(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'));
}

/**
 * What a cloud KMS client supplies to `RemoteSecp256k1Kms`: two calls on one secp256k1 signing key.
 *
 * - AWS KMS: `GetPublicKey` (DER SPKI); `Sign` with `SigningAlgorithm=ECDSA_SHA_256` and `MessageType=DIGEST` (KMS
 *   skips its hash, so the keccak digest is signed as it is), a key of spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`.
 * - GCP Cloud KMS: `GetPublicKey` (PEM by default: `spkiFromPem`); `AsymmetricSign` with the digest in `digest.sha256`
 *   on an `EC_SIGN_SECP256K1_SHA256` key (HSM only). That GCP signs a keccak digest given there is unconfirmed.
 *
 * Both facts are pinned, with their sources, in VERSIONS.md "Signing keys and KMS".
 */
export interface RemoteSecp256k1Provider {
  /** the provider's name, reported as the port's `provider` (e.g. `aws-kms`) */
  readonly provider: string;
  /** the key's public key as DER SubjectPublicKeyInfo (RFC 5280) */
  getPublicKeySpki(keyId: string): Promise<Uint8Array>;
  /** ECDSA over the 32 bytes as given (the provider must not hash them), as DER */
  signDigestDer(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * The provider-neutral cloud adapter: a `KmsPort` over secp256k1 keys a remote KMS holds (the report verifier's key,
 * D10). It reads each key's public key once and caches its address; `signDigest` asks the KMS for a DER signature,
 * normalises it to Stage 1's format and checks that it recovers to that address. If neither recovery id fits it asks
 * once more (a cloud KMS's `k` is not documented as deterministic, so a second signature can differ), then fails
 * closed. `sign` and `spkiHex` (ed25519 only) always throw: this adapter holds no ed25519 key.
 */
export class RemoteSecp256k1Kms implements KmsPort {
  readonly provider: string;
  private readonly keys = new Map<string, Promise<{ address: string; publicKeyHex: string }>>();
  constructor(private readonly remote: RemoteSecp256k1Provider) {
    this.provider = remote.provider;
  }

  private key(keyId: string): Promise<{ address: string; publicKeyHex: string }> {
    let k = this.keys.get(keyId);
    if (!k) {
      k = this.remote.getPublicKeySpki(keyId).then((spki) => {
        const point = publicKeyFromSpki(spki);
        return { address: hex(addressFromPublicKey(point)), publicKeyHex: Buffer.from(point).toString('hex') };
      });
      // a failed read is not cached: the next call asks again
      k.catch(() => this.keys.delete(keyId));
      this.keys.set(keyId, k);
    }
    return k;
  }

  async publicKey(keyId: string): Promise<{ algorithm: KeyAlgorithm; publicKeyHex: string }> {
    return { algorithm: 'secp256k1', publicKeyHex: (await this.key(keyId)).publicKeyHex };
  }

  async signerAddress(keyId: string): Promise<string> {
    return (await this.key(keyId)).address;
  }

  async signDigest(keyId: string, digest: string | Uint8Array): Promise<string> {
    const d = digestBytes(digest);
    const { address } = await this.key(keyId);
    for (let attempt = 1; ; attempt++) {
      const der = await this.remote.signDigestDer(keyId, Uint8Array.from(d));
      try {
        return signature65FromDer(der, d, address);
      } catch (e) {
        if (!(e instanceof KmsKeyError) || e.code !== 'no-recovery' || attempt >= 2) throw e;
      }
    }
  }

  async sign(keyId: string): Promise<string> {
    throw new KmsKeyError('wrong-algorithm', `key "${keyId}" is secp256k1: sign() is ed25519 only (use signDigest)`);
  }

  async spkiHex(keyId: string): Promise<string> {
    throw new KmsKeyError('wrong-algorithm', `key "${keyId}" is secp256k1: spkiHex() is ed25519 only`);
  }
}

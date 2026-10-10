import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { E2E_INFO_PREFIX, E2E_KEY_BYTES, E2E_NONCE_BYTES, E2E_TAG_BYTES, E2E_TIER3_OPENING, E2E_VERSION_V1, parseE2eEnvelope, type E2ePayloadKind } from '@merces/domain';
import type { Tier3Opening } from './attestor.ts';

/**
 * merces-e2e v1 on the devices (the format is documented in `@merces/domain` `e2e-envelope.ts`): the issuer's device
 * seals a payload for the attestor's X25519 public key; the attestor's device opens it with its private key. The server
 * only ever sees the envelope. Keys travel as base64 of their 32 raw bytes; how the issuer's device learns the
 * attestor's public key is outside the API (the case's `keyHint` names it).
 */

export interface X25519KeyPair {
  /** base64 of the 32 raw public-key bytes */
  publicKey: string;
  /** base64 of the 32 raw private-key bytes; never leaves the attestor's device */
  privateKey: string;
}

export type E2eErrorCode = 'bad-key' | 'malformed' | 'cannot-open' | 'not-an-opening';

/** Errors carry a code only: never a key, a payload or a figure. */
export class E2eError extends Error {
  constructor(readonly code: E2eErrorCode) {
    super(`e2e: ${code}`);
    this.name = 'E2eError';
  }
}

// DER prefixes of an X25519 SubjectPublicKeyInfo and PKCS#8 PrivateKeyInfo (RFC 8410) before the 32 raw key bytes
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function raw32(b64: string): Buffer {
  const b = Buffer.from(b64, 'base64');
  if (b.length !== E2E_KEY_BYTES || b.toString('base64') !== b64) throw new E2eError('bad-key');
  return b;
}

function publicKeyObject(b64: string): KeyObject {
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32(b64)]), format: 'der', type: 'spki' });
  } catch {
    throw new E2eError('bad-key');
  }
}

function privateKeyObject(b64: string): KeyObject {
  try {
    return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32(b64)]), format: 'der', type: 'pkcs8' });
  } catch {
    throw new E2eError('bad-key');
  }
}

function rawPublic(k: KeyObject): Buffer {
  return Buffer.from(k.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length));
}

/** A fresh X25519 key pair (the attestor's device keeps the private half). */
export function generateE2eKeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: rawPublic(publicKey).toString('base64'), privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)).toString('base64') };
}

function deriveKey(shared: Buffer, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, purpose: string): Buffer {
  const info = Buffer.concat([Buffer.from(E2E_INFO_PREFIX, 'utf8'), Buffer.from([0]), Buffer.from(purpose, 'utf8')]);
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), info, 32));
}

/** Seal a payload for the recipient's public key under a purpose (merces-e2e v1). Returns the base64 envelope. */
export function sealE2e(payload: Uint8Array | string, recipientPublicKey: string, purpose: string): string {
  const recipient = publicKeyObject(recipientPublicKey);
  const eph = generateKeyPairSync('x25519');
  const ephPublic = rawPublic(eph.publicKey);
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  } catch {
    throw new E2eError('bad-key'); // a low-order point
  }
  const nonce = randomBytes(E2E_NONCE_BYTES);
  const header = Buffer.concat([Buffer.from([E2E_VERSION_V1]), ephPublic, nonce]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(shared, ephPublic, rawPublic(recipient), purpose), nonce, { authTagLength: E2E_TAG_BYTES });
  cipher.setAAD(header);
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  return Buffer.concat([header, cipher.update(body), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

/**
 * Open an envelope with the recipient's private key under the purpose it was sealed for. The shape is checked with the
 * server's own parser for the payload kind first; a wrong key, a wrong purpose or a changed byte fails the tag.
 */
export function openE2e(envelope: string, recipientPrivateKey: string, kind: E2ePayloadKind): Uint8Array {
  const parsed = parseE2eEnvelope(envelope, kind);
  if (!parsed.ok) throw new E2eError('malformed');
  const { header, ephemeralPublicKey, nonce, sealed } = parsed.envelope;
  const priv = privateKeyObject(recipientPrivateKey);
  try {
    const eph = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, ephemeralPublicKey]), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: priv, publicKey: eph });
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(shared, ephemeralPublicKey, rawPublic(createPublicKey(priv)), kind.purpose), nonce, { authTagLength: E2E_TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(sealed.subarray(sealed.length - E2E_TAG_BYTES));
    return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - E2E_TAG_BYTES)), decipher.final()]));
  } catch {
    throw new E2eError('cannot-open');
  }
}

/** The issuer's device: seal a tier-3 opening for the chosen attestor (`openingCiphertext`). */
export function sealTier3Opening(o: Tier3Opening, attestorPublicKey: string): string {
  return sealE2e(JSON.stringify(o), attestorPublicKey, E2E_TIER3_OPENING.purpose);
}

/** The attestor's device: open a case's `openingCiphertext`, then check it with `checkTier3Opening`. */
export function openTier3Opening(envelope: string, attestorPrivateKey: string): Tier3Opening {
  const plain = Buffer.from(openE2e(envelope, attestorPrivateKey, E2E_TIER3_OPENING)).toString('utf8');
  let o: unknown;
  try {
    o = JSON.parse(plain);
  } catch {
    throw new E2eError('not-an-opening');
  }
  const fields = ['seriesId', 'periodId', 'incomeYtd', 'incomeSalt', 'priorIncomeYtd', 'priorSalt', 'priorIncomeCommitment', 'incomeCommitment'] as const;
  if (typeof o !== 'object' || o === null || (o as { version?: unknown }).version !== 'merces/tier3-opening/v1' || fields.some((f) => typeof (o as Record<string, unknown>)[f] !== 'string')) throw new E2eError('not-an-opening');
  return o as Tier3Opening;
}


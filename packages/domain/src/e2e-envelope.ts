/**
 * merces-e2e v1: the envelope a client seals a payload in for one recipient (the chosen attestor), end to end: the
 * server stores and serves it opaque and never holds a key. A tier-3 income opening must travel in this envelope
 * (critique M7); the server refuses anything else.
 *
 * Wire form: base64 (RFC 4648 §4: standard alphabet, padded, canonical, no whitespace) of the bytes
 *
 *   offset  size    field
 *   0       1       version: 0x01 = X25519 + HKDF-SHA256 + AES-256-GCM
 *   1       32      the sender's ephemeral X25519 public key, fresh for every envelope
 *   33      12      the AES-GCM nonce, random
 *   45      n + 16  the AES-256-GCM ciphertext of the n-byte payload, then its 16-byte tag
 *
 *   shared = X25519(ephemeral secret key, recipient public key)
 *   key    = HKDF-SHA256(ikm = shared, salt = ephemeral public key ‖ recipient public key,
 *                        info = "merces/e2e/v1" ‖ 0x00 ‖ purpose, length = 32)
 *   AAD    = the 45 header bytes (version ‖ ephemeral public key ‖ nonce)
 *
 * `purpose` names the payload and binds the key to it ("merces/tier3-opening/v1" for a tier-3 opening), so an envelope
 * sealed for one purpose does not open as another. Sealing and opening live on the devices (`@merces/poi-device`
 * `sealE2e`/`openE2e`). The server can only check the shape: `parseE2eEnvelope` refuses anything that is not a v1
 * envelope, including plain text, JSON and their hex, base64 or base64url encodings (none starts with the version
 * byte), and an envelope whose body reads as text (a payload that was framed but never encrypted).
 */

export const E2E_VERSION_V1 = 0x01;
export const E2E_KEY_BYTES = 32;
export const E2E_NONCE_BYTES = 12;
export const E2E_TAG_BYTES = 16;
/** version ‖ ephemeral public key ‖ nonce */
export const E2E_HEADER_BYTES = 1 + E2E_KEY_BYTES + E2E_NONCE_BYTES;
/** The HKDF `info` prefix; the purpose follows a zero byte. */
export const E2E_INFO_PREFIX = 'merces/e2e/v1';

/** What a payload kind allows: its purpose label and its size bounds (bytes of the payload, before sealing). */
export interface E2ePayloadKind {
  purpose: string;
  minPayloadBytes: number;
  maxPayloadBytes: number;
}

/**
 * A tier-3 opening (`merces/tier3-opening/v1` JSON: two year-to-date figures, two field salts and two commitments) is a
 * few hundred bytes; the bounds refuse an empty or stub envelope and keep the column to openings.
 */
export const E2E_TIER3_OPENING: E2ePayloadKind = { purpose: 'merces/tier3-opening/v1', minPayloadBytes: 64, maxPayloadBytes: 4096 };

export type E2eEnvelopeRefusal = 'not-base64' | 'too-short' | 'too-long' | 'unknown-version' | 'not-a-key' | 'not-a-nonce' | 'plaintext';

/** Value-free reasons, for error messages. */
export const E2E_REFUSAL_TEXT: Record<E2eEnvelopeRefusal, string> = {
  'not-base64': 'not canonical base64',
  'too-short': 'too short for a sealed payload of this kind',
  'too-long': 'too long for a payload of this kind',
  'unknown-version': 'the version byte is not 0x01',
  'not-a-key': 'the ephemeral public key is not a key',
  'not-a-nonce': 'the nonce is not random',
  plaintext: 'the body reads as plain text, so it was not encrypted',
};

export interface E2eEnvelope {
  version: typeof E2E_VERSION_V1;
  /** the 45 header bytes: the AEAD's associated data */
  header: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  /** ciphertext ‖ tag */
  sealed: Uint8Array;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Parse a v1 envelope's shape for a payload kind. Never decrypts (the server has no key); never echoes the value. */
export function parseE2eEnvelope(value: string, kind: Pick<E2ePayloadKind, 'minPayloadBytes' | 'maxPayloadBytes'>): { ok: true; envelope: E2eEnvelope } | { ok: false; code: E2eEnvelopeRefusal } {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) return { ok: false, code: 'not-base64' };
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return { ok: false, code: 'not-base64' };
  if (bytes[0] !== E2E_VERSION_V1) return { ok: false, code: 'unknown-version' };
  const payloadBytes = bytes.length - E2E_HEADER_BYTES - E2E_TAG_BYTES;
  if (payloadBytes < Math.max(1, kind.minPayloadBytes)) return { ok: false, code: 'too-short' };
  if (payloadBytes > kind.maxPayloadBytes) return { ok: false, code: 'too-long' };
  // everything after the version byte must look random: a framed but unencrypted payload (or a key and nonce typed in
  // as text) reads as text
  if (readsAsText(bytes.subarray(1))) return { ok: false, code: 'plaintext' };
  const ephemeralPublicKey = new Uint8Array(bytes.subarray(1, 1 + E2E_KEY_BYTES));
  const nonce = new Uint8Array(bytes.subarray(1 + E2E_KEY_BYTES, E2E_HEADER_BYTES));
  if (allSame(ephemeralPublicKey)) return { ok: false, code: 'not-a-key' };
  if (allSame(nonce)) return { ok: false, code: 'not-a-nonce' };
  return { ok: true, envelope: { version: E2E_VERSION_V1, header: new Uint8Array(bytes.subarray(0, E2E_HEADER_BYTES)), ephemeralPublicKey, nonce, sealed: new Uint8Array(bytes.subarray(E2E_HEADER_BYTES)) } };
}

function allSame(b: Uint8Array): boolean {
  return b.every((x) => x === b[0]);
}

/** Printable ASCII and tab, newline, carriage return: about 38% of uniformly random bytes. */
function isTextByte(x: number): boolean {
  return (x >= 0x20 && x <= 0x7e) || x === 0x09 || x === 0x0a || x === 0x0d;
}

/**
 * Whether decoded bytes read as text rather than ciphertext: a run of ten ASCII digits (an income figure or a salt;
 * about 1 in 10^14 per position for random bytes), or, from 32 bytes on, nine in ten bytes printable (random bytes
 * average 38%). Exported for the server's heuristic on the other end-to-end fields.
 */
export function readsAsText(b: Uint8Array): boolean {
  let digits = 0;
  let text = 0;
  for (const x of b) {
    digits = x >= 0x30 && x <= 0x39 ? digits + 1 : 0;
    if (digits >= 10) return true;
    if (isTextByte(x)) text++;
  }
  return b.length >= 32 && text / b.length >= 0.9;
}

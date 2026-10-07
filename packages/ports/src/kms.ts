import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Key-management port. Signing keys never enter the repository: production uses a cloud KMS behind this
 * interface; development uses deterministic keys derived from a dev seed (never for real funds).
 */
export type KeyAlgorithm = 'ed25519' | 'secp256k1';

export interface KmsPort {
  readonly provider: string;
  /** hex-encoded public key: ed25519 → 32 raw bytes; secp256k1 → 65-byte uncompressed */
  publicKey(keyId: string): Promise<{ algorithm: KeyAlgorithm; publicKeyHex: string }>;
  /** raw signature, hex: ed25519 → 64 bytes; secp256k1 → 65 bytes r||s||v */
  sign(keyId: string, message: Uint8Array): Promise<string>;
  /** ed25519 public key as SPKI DER hex (what the simulator registers for report verifiers) */
  spkiHex(keyId: string): Promise<string>;
}

export const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519RawToSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]);
}

/** Local dev signer: keys derived from sha256(seed || keyId). Deterministic so that restarts keep the same keys. */
export class LocalKms implements KmsPort {
  readonly provider = 'local';
  private readonly cache = new Map<string, { algorithm: KeyAlgorithm; ed?: KeyObject; secp?: Uint8Array }>();
  constructor(private readonly seed: string, private readonly algorithms: Record<string, KeyAlgorithm> = {}) {}

  private material(keyId: string) {
    let m = this.cache.get(keyId);
    if (m) return m;
    const algorithm = this.algorithms[keyId] ?? (keyId.includes('evm') || keyId.includes('secp') ? 'secp256k1' : 'ed25519');
    const raw = createHash('sha256').update(`merces-local-kms:${this.seed}:${keyId}`).digest();
    if (algorithm === 'ed25519') {
      // PKCS#8 wrapper for a raw ed25519 seed
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
      m = { algorithm, ed: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
    } else {
      m = { algorithm, secp: new Uint8Array(raw) };
    }
    this.cache.set(keyId, m);
    return m;
  }

  async publicKey(keyId: string): Promise<{ algorithm: KeyAlgorithm; publicKeyHex: string }> {
    const m = this.material(keyId);
    if (m.algorithm === 'ed25519') {
      const spki = createPublicKey(m.ed!).export({ format: 'der', type: 'spki' }) as Buffer;
      return { algorithm: 'ed25519', publicKeyHex: spki.subarray(spki.length - 32).toString('hex') };
    }
    return { algorithm: 'secp256k1', publicKeyHex: bytesToHex(secp256k1.getPublicKey(m.secp!, false)) };
  }

  async spkiHex(keyId: string): Promise<string> {
    const { publicKeyHex } = await this.publicKey(keyId);
    return ed25519RawToSpki(Buffer.from(publicKeyHex, 'hex')).toString('hex');
  }

  async sign(keyId: string, message: Uint8Array): Promise<string> {
    const m = this.material(keyId);
    if (m.algorithm === 'ed25519') return edSign(null, Buffer.from(message), m.ed!).toString('hex');
    const digest = keccak_256(message);
    const sig = secp256k1.sign(digest, m.secp!, { prehash: false, format: 'recovered' });
    return bytesToHex(sig);
  }

  /** EVM address for a secp256k1 key. */
  async evmAddress(keyId: string): Promise<string> {
    const { publicKeyHex } = await this.publicKey(keyId);
    const pub = Buffer.from(publicKeyHex, 'hex').subarray(1);
    return '0x' + bytesToHex(keccak_256(pub).slice(12));
  }
}

export function generateEd25519(): { privateKeyPem: string; publicKeyRawHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKeyRawHex: spki.subarray(spki.length - 32).toString('hex') };
}

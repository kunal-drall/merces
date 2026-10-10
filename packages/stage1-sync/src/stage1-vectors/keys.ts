import { createHash, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { attestationMessage, type VerifierAttestation } from '@merces/domain';
import { RunnerError } from './errors.ts';
import type { VectorKeys } from './load.ts';

/**
 * Report-verifier keys for the merces backend (shim SH-REG-3; S1 plan §5.1 `keys.ts`).
 *
 * Stage 1's vectors carry secp256k1 test keys (`keys[name]`: seed, private key, address) and, in its reference
 * simulator, a "signature" means "this registered key signed". Our verifier attestation is ed25519 over attestation v1
 * until S4 moves it to secp256k1, so each vector key becomes an ed25519 key derived from it:
 * `seed = sha256("merces-vector-ed25519:" ‖ privateKeyBytes)`. It is registered under the vector's key name as its
 * `keyId`, and the runner signs tier-2 attestations with it. An attestation naming a key that was never registered as a
 * verifier key (04#68 signs with `attestor1`) is still signed, under that name, so the chain refuses it the way Stage 1
 * does (InvalidVerifierSignature).
 *
 * Private keys stay in this module's memory; nothing here is printed or persisted.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DOMAIN = Buffer.from('merces-vector-ed25519:', 'utf8');

export interface VectorEd25519Key {
  keyId: string;
  /** DER SPKI, hex: what `registerVerifierKey.publicKey` carries */
  publicKeyHex: string;
  attest(input: Omit<VerifierAttestation, 'keyId' | 'signature'>): VerifierAttestation;
}

export class VectorKeyring {
  private readonly cache = new Map<string, VectorEd25519Key>();
  constructor(private readonly keys: VectorKeys) {}

  /** The ed25519 key derived from vector key `name`. */
  ed25519(name: string): VectorEd25519Key {
    let k = this.cache.get(name);
    if (!k) {
      const vk = this.keys[name];
      if (!vk || typeof vk.privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(vk.privateKey)) throw new RunnerError(`the vector has no usable key named ${name}`);
      const seed = createHash('sha256').update(DOMAIN).update(Buffer.from(vk.privateKey.slice(2), 'hex')).digest();
      const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
      const publicKeyHex = (createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).toString('hex');
      k = {
        keyId: name,
        publicKeyHex,
        attest: (input) => ({ keyId: name, ...input, signature: '0x' + edSign(null, Buffer.from(attestationMessage(input)), priv).toString('hex') }),
      };
      this.cache.set(name, k);
    }
    return k;
  }
}

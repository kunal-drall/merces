import { assertLocalSigningNetwork, attestationOf, signature65Hex, signingDigest, type Attestation, type DigestSigner, type SigningDomain, type SigningFields, type SigningKind } from '@merces/domain';
import { addressFromPrivateKey, signDigest, verifySignature } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { RunnerError } from './errors.ts';
import type { VectorKeys } from './load.ts';

/**
 * The vector keys as signers (S4 WP6; S4 plan §4 "Signing").
 *
 * Stage 1's vectors carry secp256k1 test keys (`keys[name]`: seed, private key, address; seed `"<vector>:<name>"`), and
 * Stage 1's harnesses register those addresses and sign the SPEC §1.4 messages themselves (vectors README:48-50). So does
 * this runner: `signer(name)` checks the key is Stage 1's published test key for its seed (`deriveTestPrivateKey(seed)`)
 * and that its address is the key's own (`addressFromPrivateKey`), then signs raw digests with Stage 1's `signDigest`.
 * `attest` builds the message over the chain's signing domain (`ChainInfo.signing`) and the series key
 * (`SeriesState.seriesKey`), refusing any domain but the simulator's local ids first (a mainnet, and a testnet too:
 * these are published test keys, never for a live network), and signs it.
 *
 * Wrong-key cases need no special handling: the named key signs, and the chain finds it in the wrong set (04#68 signs a
 * tier-2 report with `attestor1`, which is no verifier key: InvalidVerifierSignature).
 *
 * Private keys stay in this module's memory; nothing here is printed or persisted, and errors name the key, never its
 * value. The known-answer `testKeys` (seeds `attestor1`, …) are not these keys: they serve the byte-exact tests.
 */
/** A vector key: signs a raw digest, or builds and signs one of Stage 1's messages (`attest`). */
export interface VectorSigner extends DigestSigner {
  attest<K extends SigningKind>(kind: K, domain: SigningDomain, seriesKey: string, fields: SigningFields[K]): Promise<Attestation>;
}

export class VectorKeyring {
  private readonly cache = new Map<string, VectorSigner>();
  constructor(private readonly keys: VectorKeys) {}

  /** The signer of vector key `name`, after checking it is Stage 1's published test key for its seed. */
  signer(name: string): VectorSigner {
    let k = this.cache.get(name);
    if (!k) {
      const vk = (this.keys as Record<string, { seed?: unknown; privateKey?: unknown; address?: unknown } | undefined>)[name];
      if (!vk || typeof vk.privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(vk.privateKey) || typeof vk.seed !== 'string' || typeof vk.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vk.address)) {
        throw new RunnerError(`the vector has no usable key named ${name}`);
      }
      const priv = Uint8Array.from(Buffer.from(vk.privateKey.slice(2), 'hex'));
      if (!Buffer.from(deriveTestPrivateKey(vk.seed)).equals(Buffer.from(priv))) throw new RunnerError(`the vector's key ${name} is not Stage 1's test key for its seed`);
      const address = '0x' + Buffer.from(addressFromPrivateKey(priv)).toString('hex');
      if (address !== vk.address.toLowerCase()) throw new RunnerError(`the vector's key ${name} has another key's address`);
      const signDigestHex = async (digest: string): Promise<string> => {
        if (typeof digest !== 'string' || !/^0x[0-9a-f]{64}$/.test(digest)) throw new RunnerError('a digest is 32-byte 0x-hex');
        const d = Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
        const sig = signDigest(d, priv);
        if (!verifySignature(d, sig.bytes, address)) throw new RunnerError(`the signature of ${name} does not recover to its address`);
        return signature65Hex(sig);
      };
      k = {
        address,
        signDigest: signDigestHex,
        attest: async (kind, domain, seriesKey, fields) => {
          assertLocalSigningNetwork(domain);
          const { digest } = signingDigest(kind, { domain: domain.domain, seriesKey }, fields);
          return attestationOf({ signer: address, signature: await signDigestHex(digest) });
        },
      };
      this.cache.set(name, k);
    }
    return k;
  }
}

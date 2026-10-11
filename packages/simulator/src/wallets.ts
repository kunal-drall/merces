import { createHash } from 'node:crypto';
import {
  assertSigningNetwork, signature65Hex, signingDigest, type Attestation, type ChainFamily, type DigestSigner, type SignedTx, type SigningDomain, type SigningFields,
  type SigningKind, type UnsignedTx, type WalletSigner,
} from '@merces/domain';
import { addressFromPrivateKey, signDigest as stage1SignDigest, verifySignature } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { deriveAddress } from './addresses.ts';

/** A test wallet for the simulator. Its "signature" is the string `sim:<address>`; the simulator checks it. */
export class SimWallet implements WalletSigner {
  readonly address: string;
  constructor(
    readonly family: ChainFamily,
    readonly label: string,
    explicitAddress?: string,
  ) {
    this.address = explicitAddress ?? deriveAddress(family, `wallet:${label}`);
  }
  async sign(tx: UnsignedTx): Promise<SignedTx> {
    return { tx, signatures: { [this.address]: `sim:${this.address}` } };
  }
  /** Co-sign an already signed transaction. */
  async coSign(signed: SignedTx): Promise<SignedTx> {
    return { tx: signed.tx, signatures: { ...signed.signatures, [this.address]: `sim:${this.address}` } };
  }
  async signMessage(message: Uint8Array): Promise<string> {
    return 'sim:' + createHash('sha256').update(this.address).update(message).digest('hex');
  }
  static verifyMessage(address: string, message: Uint8Array, signature: string): boolean {
    return signature === 'sim:' + createHash('sha256').update(address).update(message).digest('hex');
  }
}

/** The admin multisig stand-in: the simulator derives it from the label role:admin. */
export function simAdminWallet(family: ChainFamily): SimWallet {
  return new SimWallet(family, 'admin', deriveAddress(family, 'role:admin'));
}

/**
 * A published secp256k1 TEST key that signs Stage 1 digests (`DigestSigner`, S4 WP6): the simulator harness's report
 * verifier key (seed `sim-verifier:<label>`), and later its attestor keys. The key is Stage 1's test-key derivation of
 * the seed (`deriveTestPrivateKey`: `keccak256("MERCES_TEST_KEY" ‖ seed) mod (n − 1) + 1`), so anyone who knows the seed
 * knows the key: simulator and tests only, never a live chain. Signing is Stage 1's `signDigest` (RFC 6979, low `s`,
 * `v ∈ {27, 28}`), checked against the key's address before it is returned.
 *
 * `attest` is how the harness signs a message: it refuses a domain off the signing allow-list or on a mainnet (local ids
 * allowed: the simulator's) before it builds and signs the digest (S4 D6, every signer refuses mainnet).
 */
export class SimSigner implements DigestSigner {
  readonly address: string;
  private readonly key: Uint8Array;
  constructor(readonly seed: string) {
    this.key = deriveTestPrivateKey(seed);
    this.address = '0x' + Buffer.from(addressFromPrivateKey(this.key)).toString('hex');
  }

  /** The harness's report verifier key `label` (seed `sim-verifier:<label>`). */
  static verifier(label = 'verifier-1'): SimSigner {
    return new SimSigner(`sim-verifier:${label}`);
  }

  async signDigest(digest: string): Promise<string> {
    if (typeof digest !== 'string' || !/^0x[0-9a-f]{64}$/i.test(digest)) throw new RangeError('digest must be 32-byte 0x-hex');
    const d = Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
    const sig = stage1SignDigest(d, this.key);
    if (!verifySignature(d, sig.bytes, this.address)) throw new Error('SimSigner: the signature does not recover to the key');
    return signature65Hex(sig);
  }

  /**
   * Builds Stage 1's message of `kind` over `fields` for `domain` and `seriesKey`, and signs its digest. Refuses a
   * domain off the allow-list or on a mainnet first (`assertSigningNetwork`, local ids allowed).
   */
  async attest<K extends SigningKind>(kind: K, domain: SigningDomain, seriesKey: string, fields: SigningFields[K]): Promise<Attestation & { digest: string }> {
    assertSigningNetwork(domain, { allowLocal: true });
    const { digest } = signingDigest(kind, { domain: domain.domain, seriesKey }, fields);
    return { signer: this.address, signature: await this.signDigest(digest), digest };
  }
}

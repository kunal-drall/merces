import { createHash } from 'node:crypto';
import {
  assertLocalSigningNetwork, personalMessageDigest, signature65Hex, signingDigest, type Attestation, type ChainFamily, type DigestSigner, type SignedTx, type SigningDomain,
  type SigningFields, type SigningKind, type UnsignedTx, type WalletSigner,
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
 * verifier key (seed `sim-verifier:<label>`) and its attestor keys (seed `sim-attestor:<label>`, S4 WP7), and the dev
 * attestor keys dev:mock links (seed `merces-dev-attestor:<n>`). The key is Stage 1's test-key derivation of
 * the seed (`deriveTestPrivateKey`: `keccak256("MERCES_TEST_KEY" ‖ seed) mod (n − 1) + 1`), so anyone who knows the seed
 * knows the key: simulator and tests only, never a live chain. Signing is Stage 1's `signDigest` (RFC 6979, low `s`,
 * `v ∈ {27, 28}`), checked against the key's address before it is returned.
 *
 * `attest` is how the harness signs a message: it refuses any domain but the simulator's local ids (Solana localnet 104,
 * EVM 31337) before it builds and signs the digest: a mainnet (S4 D6, every signer refuses mainnet) and a testnet too,
 * since a published test key never signs for a live network.
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

  /** The harness's attestor key `label` (seed `sim-attestor:<label>`; S4 WP7). */
  static attestor(label = 'attestor-1'): SimSigner {
    return new SimSigner(`sim-attestor:${label}`);
  }

  /**
   * EIP-191 `personal_sign` of `text`: Stage 1's `signDigest` over `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖
   * text)` (`personalMessageDigest`, viem's `hashMessage`), 65 bytes `r ‖ s ‖ v`. How the key proves control when it is
   * linked to an account (S4 WP7), and, until S4 WP9, how an attestor signs the tier-3 and FX texts. Its digest's
   * pre-image starts with 0x19, never a `MERCES_*` message's: it can never be an attestation.
   */
  async personalSign(text: string | Uint8Array): Promise<string> {
    return this.signDigest(personalMessageDigest(text));
  }

  async signDigest(digest: string): Promise<string> {
    if (typeof digest !== 'string' || !/^0x[0-9a-f]{64}$/i.test(digest)) throw new RangeError('digest must be 32-byte 0x-hex');
    const d = Uint8Array.from(Buffer.from(digest.slice(2), 'hex'));
    const sig = stage1SignDigest(d, this.key);
    if (!verifySignature(d, sig.bytes, this.address)) throw new Error('SimSigner: the signature does not recover to the key');
    return signature65Hex(sig);
  }

  /**
   * Builds Stage 1's message of `kind` over `fields` for `domain` and `seriesKey`, and signs its digest. Refuses any
   * domain but a local id first (`assertLocalSigningNetwork`: a mainnet, a testnet, a forged domain).
   */
  async attest<K extends SigningKind>(kind: K, domain: SigningDomain, seriesKey: string, fields: SigningFields[K]): Promise<Attestation & { digest: string }> {
    assertLocalSigningNetwork(domain);
    const { digest } = signingDigest(kind, { domain: domain.domain, seriesKey }, fields);
    return { signer: this.address, signature: await this.signDigest(digest), digest };
  }
}

/**
 * A harness attestor (S4 WP7, D4): a published secp256k1 test key (`SimSigner`, seed `sim-attestor:<label>`) whose
 * 20-byte address is the attestor on both personalities, registered by that address and linked to an account by its
 * own EIP-191 proof (`personalSign`). It signs Stage 1 digests (`signDigest`, `attest`).
 *
 * Transitional until S4 WP13: the flows that still take the attestor as a co-signer of a transaction (approvePause,
 * amendTerms, extinguish, a tier-3 report, the FX fallback rate) are signed by a simulator wallet at the key's address
 * (it extends `SimWallet(family, label, key.address)`: a `sim:` co-signature, which only the simulator accepts). Each
 * of those flows moves to the key's own Stage 1 signature (S4 WP9-WP12), and the wallet goes with WP13.
 */
export class SimAttestor extends SimWallet implements DigestSigner {
  readonly key: SimSigner;
  constructor(family: ChainFamily, label: string, key: SimSigner = SimSigner.attestor(label)) {
    super(family, label, key.address);
    this.key = key;
  }
  signDigest(digest: string): Promise<string> {
    return this.key.signDigest(digest);
  }
  attest<K extends SigningKind>(kind: K, domain: SigningDomain, seriesKey: string, fields: SigningFields[K]): Promise<Attestation & { digest: string }> {
    return this.key.attest(kind, domain, seriesKey, fields);
  }
  personalSign(text: string | Uint8Array): Promise<string> {
    return this.key.personalSign(text);
  }
}

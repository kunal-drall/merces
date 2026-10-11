import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import bs58 from 'bs58';
import { verifyMessage } from 'viem';
import { toChecksumAddress } from '@merces/math';
import type { ChainFamily } from '@merces/domain';
import { ed25519RawToSpki } from './kms.ts';

/**
 * Wallet message-signature verification for sign-in (E2).
 *  - Solana: ed25519 over the UTF-8 message, signature base58 or hex (what wallet adapters' signMessage return).
 *  - EVM: EIP-191 personal_sign, verified with viem (recovers the address).
 *  - simulator: SimWallet signatures ("sim:" + sha256(address || message)) — accepted only when allowSimulator is set.
 */
export async function verifyWalletSignature(params: { family: ChainFamily; address: string; message: string; signature: string; allowSimulator?: boolean }): Promise<boolean> {
  const { family, address, message, signature } = params;
  if (signature.startsWith('sim:')) {
    if (!params.allowSimulator) return false;
    return signature === 'sim:' + createHash('sha256').update(address).update(Buffer.from(message)).digest('hex');
  }
  if (family === 'solana') {
    try {
      const pub = createPublicKey({ key: ed25519RawToSpki(bs58.decode(address)), format: 'der', type: 'spki' });
      const sig = signature.startsWith('0x') ? Buffer.from(signature.slice(2), 'hex') : /^[0-9a-fA-F]{128}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.from(bs58.decode(signature));
      return edVerify(null, Buffer.from(message), pub, sig);
    } catch {
      return false;
    }
  }
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

/** The sign-in message a wallet signs. Human-readable, domain-bound, nonce-bound. */
export function signInMessage(params: { domain: string; chain: string; address: string; nonce: string; issuedAt: string }): string {
  return [`${params.domain} wants you to sign in with your ${params.chain} wallet.`, '', `Address: ${params.address}`, `Nonce: ${params.nonce}`, `Issued at: ${params.issuedAt}`, '', 'Signing is free and does not send a transaction.'].join('\n');
}

/**
 * The text an attestor key signs to prove it is the account's (S4 WP7, D4; `POST /me/signer-keys/challenge`): an
 * EIP-191 `personal_sign` text bound to the host, the account, the key, a one-time nonce and the issue time. It says
 * what it does: it links a key and nothing else. Its EIP-191 digest starts with 0x19, so it can never be a Stage 1
 * `MERCES_*` message digest: a link proof is never an attestation. The key is shown in EIP-55 form (display only).
 */
export function signerKeyLinkMessage(params: { domain: string; accountId: string; address: string; nonce: string; issuedAt: string }): string {
  return [
    `${params.domain} asks you to link an attestor key to your account.`,
    '',
    `Account: ${params.accountId}`,
    `Key: ${toChecksumAddress(params.address)}`,
    `Nonce: ${params.nonce}`,
    `Issued at: ${params.issuedAt}`,
    '',
    'This links an attestor key to your account. It is not an attestation and it moves no funds.',
  ].join('\n');
}

/**
 * An EIP-191 `personal_sign` of `message` by the secp256k1 key whose 20-byte address is `address` (S4 WP7): a 65-byte
 * `0x` hex signature checked with viem's `verifyMessage` (it recovers the address). A simulator signature (`sim:`) is
 * never one, in any mode. It is how an attestor key proves control when it is linked to an account (the link
 * challenge), and nothing else: every attestation is a Stage 1 signature over a raw `MERCES_*` digest (S4 WP9-WP13).
 */
export async function verifyKeyPersonalSignature(params: { address: string; message: string; signature: string }): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(params.signature) || !/^0x[0-9a-f]{40}$/.test(params.address)) return false;
  return verifyWalletSignature({ family: 'evm', address: params.address, message: params.message, signature: params.signature, allowSimulator: false });
}

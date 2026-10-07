import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import bs58 from 'bs58';
import { verifyMessage } from 'viem';
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

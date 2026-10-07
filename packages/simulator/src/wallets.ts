import { createHash } from 'node:crypto';
import type { ChainFamily, SignedTx, UnsignedTx, WalletSigner } from '@merces/domain';
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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolveSecret } from './secrets.ts';

/**
 * Envelope encryption for the terms vault, attestor documents and application notes: AES-256-GCM with a
 * key from the key-management layer. The key id is stored beside the ciphertext so rotation is possible.
 */
export interface VaultCrypto {
  readonly keyId: string;
  encrypt(plaintext: string, aad: string): string;
  decrypt(ciphertext: string, aad: string): string;
}

export class AesGcmVault implements VaultCrypto {
  private readonly key: Buffer;
  constructor(
    readonly keyId: string,
    keyMaterialHex: string,
  ) {
    const raw = Buffer.from(keyMaterialHex.replace(/^0x/, ''), 'hex');
    this.key = raw.length === 32 ? raw : createHash('sha256').update(keyMaterialHex).digest();
  }
  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1.${this.keyId}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }
  decrypt(ciphertext: string, aad: string): string {
    const [v, keyId, ivB, tagB, ctB] = ciphertext.split('.');
    if (v !== 'v1' || !keyId || !ivB || !tagB || !ctB) throw new Error('bad vault ciphertext');
    if (keyId !== this.keyId) throw new Error(`ciphertext uses key ${keyId}, vault has ${this.keyId}`);
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]).toString('utf8');
  }
}

/** The vault key comes from the environment; the dev default is accepted only while every chain is the simulator. */
export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { simulatorOnly: boolean } = { simulatorOnly: true }): AesGcmVault {
  const hex = resolveSecret(env, 'MERCES_VAULT_KEY_HEX', { simulatorOnly: opts.simulatorOnly, devDefault: 'dev-vault-key-not-for-production' });
  return new AesGcmVault(env.MERCES_VAULT_KEY_ID ?? 'vault-dev-1', hex);
}

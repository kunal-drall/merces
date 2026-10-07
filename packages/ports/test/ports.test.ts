import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { AesGcmVault, LocalKms, MockESign, MockIdentityCheck, ed25519RawToSpki, signInMessage, verifyWalletSignature } from '../src/index.ts';

describe('LocalKms', () => {
  it('derives stable ed25519 keys and produces verifiable signatures', async () => {
    const kms = new LocalKms('seed');
    const a = await kms.publicKey('verifier-1');
    const b = await new LocalKms('seed').publicKey('verifier-1');
    expect(a).toEqual(b);
    expect(a.algorithm).toBe('ed25519');
    const msg = new TextEncoder().encode('hello');
    const sig = await kms.sign('verifier-1', msg);
    const pub = createPublicKey({ key: ed25519RawToSpki(Buffer.from(a.publicKeyHex, 'hex')), format: 'der', type: 'spki' });
    expect(edVerify(null, Buffer.from(msg), pub, Buffer.from(sig, 'hex'))).toBe(true);
    expect((await kms.spkiHex('verifier-1')).length).toBe(88);
  });
  it('derives secp256k1 keys with an EVM address', async () => {
    const kms = new LocalKms('seed');
    expect(await kms.evmAddress('keeper-evm')).toMatch(/^0x[0-9a-f]{40}$/);
    expect((await kms.sign('keeper-evm', new Uint8Array([1, 2, 3]))).length).toBe(130);
  });
});

describe('vault crypto', () => {
  it('round-trips with AAD binding', () => {
    const v = new AesGcmVault('k1', 'dev-key');
    const ct = v.encrypt('{"threshold":"60000000000"}', 'draft-1');
    expect(ct).not.toContain('60000000000');
    expect(v.decrypt(ct, 'draft-1')).toBe('{"threshold":"60000000000"}');
    expect(() => v.decrypt(ct, 'draft-2')).toThrow();
  });
});

describe('wallet signatures', () => {
  it('verifies EVM personal_sign and rejects the wrong address', async () => {
    const acct = privateKeyToAccount('0x' + '11'.repeat(32));
    const message = signInMessage({ domain: 'merces.test', chain: 'monad', address: acct.address.toLowerCase(), nonce: 'n', issuedAt: 'now' });
    const signature = await acct.signMessage({ message });
    expect(await verifyWalletSignature({ family: 'evm', address: acct.address.toLowerCase(), message, signature })).toBe(true);
    expect(await verifyWalletSignature({ family: 'evm', address: '0x' + '22'.repeat(20), message, signature })).toBe(false);
  });
  it('verifies Solana ed25519 signatures', async () => {
    const kms = new LocalKms('solana-user');
    const { publicKeyHex } = await kms.publicKey('wallet');
    const bs58 = (await import('bs58')).default;
    const address = bs58.encode(Buffer.from(publicKeyHex, 'hex'));
    const message = 'sign me';
    const signature = await kms.sign('wallet', new TextEncoder().encode(message));
    expect(await verifyWalletSignature({ family: 'solana', address, message, signature })).toBe(true);
    expect(await verifyWalletSignature({ family: 'solana', address, message: 'other', signature })).toBe(false);
  });
  it('accepts simulator signatures only when allowed', async () => {
    const { SimWallet } = await import('@merces/simulator');
    const w = new SimWallet('solana', 'x');
    const sig = await w.signMessage(new TextEncoder().encode('m'));
    expect(await verifyWalletSignature({ family: 'solana', address: w.address, message: 'm', signature: sig, allowSimulator: true })).toBe(true);
    expect(await verifyWalletSignature({ family: 'solana', address: w.address, message: 'm', signature: sig })).toBe(false);
  });
});

describe('mock providers', () => {
  it('identity auto-passes and esign completes with an audit trail', async () => {
    const id = new MockIdentityCheck();
    const c = await id.start({ applicationId: 'a1', accountId: 'acc', kind: 'issuer', country: 'US' });
    expect(await id.status(c.checkId)).toBe('passed');
    const es = new MockESign();
    const env = await es.createEnvelope({ sessionId: 's1', signerAccountId: 'acc', documents: [{ name: 'HEU', body: 'contract text' }] });
    expect(await es.status(env.envelopeId)).toBe('sent');
    await es.complete(env.envelopeId);
    const doc = await es.signedDocument(env.envelopeId);
    expect(doc?.body).toContain('SIGNATURE AUDIT TRAIL');
  });
});

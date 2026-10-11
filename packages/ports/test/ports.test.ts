import { afterAll, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { hashMessage } from 'viem';
import { mockProve, personalMessageDigest, recoverSigner, type Groth16ProofJson } from '@merces/domain';
import { addressFromPrivateKey, isLowS, keccak256, parseSignature, publicKeyFromPrivate, signDigest } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import {
  AesGcmVault, Groth16ReportVerifier, KmsKeyError, LocalKms, MockESign, MockIdentityCheck, MockProofVerifier, ed25519RawToSpki, kmsDigestSigner, proverArtifactFile, reportProofSystemFromEnv,
  reportProofVerifier, shutdownProofSystem, signInMessage, stage1ProverArtifacts, verifyWalletSignature,
} from '../src/index.ts';
import { resolveSecret } from '../src/secrets.ts';

/*
 * S4 cause codes:
 *  - S4-G: Stage 1's signing primitives through `@merces/math` and `@merces/domain` (signing.ts): the EIP-191 link-proof
 *    digest agrees with viem.
 *  - S4-KMS: the KMS port signs a secp256k1 digest as Stage 1 does (`signDigest`: `r ‖ s ‖ v`, low s, v ∈ {27, 28},
 *    self-verified) and `sign` is ed25519 only; a local key id names its algorithm (no inference from the id, an unknown
 *    id is an error); the local secp256k1 key is Stage 1's test-key derivation of `merces-local-kms:<seed>:<keyId>`.
 *  - S4-T2: the report verifier's key is secp256k1 (S4 WP6), so the ed25519 SPKI export it needed is gone; ed25519 keys
 *    stay for Solana fee payers.
 */

/** A raised KmsKeyError with this code (and no seed in its message). */
async function refused(p: Promise<unknown>, code: string, seed?: string): Promise<void> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(KmsKeyError);
  expect((e as KmsKeyError).code).toBe(code);
  if (seed) expect((e as Error).message).not.toContain(seed);
}

describe('LocalKms', () => {
  it('derives stable ed25519 keys and produces verifiable signatures', async () => {
    // cause S4-KMS: the key id names its algorithm; the ed25519 derivation is unchanged (sha256 of the label)
    const kms = new LocalKms('seed', { 'verifier-1': 'ed25519' });
    const a = await kms.publicKey('verifier-1');
    const b = await new LocalKms('seed', { 'verifier-1': 'ed25519' }).publicKey('verifier-1');
    expect(a).toEqual(b);
    expect(a.algorithm).toBe('ed25519');
    const msg = new TextEncoder().encode('hello');
    const sig = await kms.sign('verifier-1', msg);
    const pub = createPublicKey({ key: ed25519RawToSpki(Buffer.from(a.publicKeyHex, 'hex')), format: 'der', type: 'spki' });
    expect(edVerify(null, Buffer.from(msg), pub, Buffer.from(sig, 'hex'))).toBe(true);
    // the secp256k1 methods refuse an ed25519 key
    await refused(kms.signerAddress('verifier-1'), 'wrong-algorithm');
    await refused(kms.signDigest('verifier-1', '0x' + '11'.repeat(32)), 'wrong-algorithm');
  });

  it('cause S4-KMS: a secp256k1 key signs a digest as Stage 1 does: r ‖ s ‖ v, low s, v ∈ {27, 28}, recovering to its address', async () => {
    const kms = new LocalKms('seed', { 'keeper-evm': 'secp256k1' });
    // the key is Stage 1's test-key derivation of the label (in [1, n − 1]); it was raw sha256 before S4, unreduced
    const priv = deriveTestPrivateKey('merces-local-kms:seed:keeper-evm');
    const address = '0x' + Buffer.from(addressFromPrivateKey(priv)).toString('hex');
    expect(await kms.signerAddress('keeper-evm')).toBe(address);
    expect(await kms.publicKey('keeper-evm')).toEqual({ algorithm: 'secp256k1', publicKeyHex: Buffer.from(publicKeyFromPrivate(priv)).toString('hex') });
    for (const text of ['MERCES_REPORT_V1 stand-in', 'another digest', '']) {
      const digest = '0x' + Buffer.from(keccak256(new TextEncoder().encode(text))).toString('hex');
      const sig = await kms.signDigest('keeper-evm', digest);
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
      const parsed = parseSignature(sig); // Stage 1's parser: v ∈ {27, 28}, r in range, low s
      expect([27, 28]).toContain(parsed.v);
      expect(isLowS(parsed.s)).toBe(true);
      expect(recoverSigner(digest, sig)).toBe(address);
      // byte for byte Stage 1's signDigest (RFC 6979), the digest signed as it is: no hash, no prefix
      expect(sig).toBe('0x' + Buffer.from(signDigest(digest, priv).bytes).toString('hex'));
      // bytes and hex digests are the same digest
      expect(await kms.signDigest('keeper-evm', Buffer.from(digest.slice(2), 'hex'))).toBe(sig);
    }
    // a digest must be exactly 32 bytes
    await refused(kms.signDigest('keeper-evm', '0x' + '11'.repeat(31)), 'malformed-digest');
    await refused(kms.signDigest('keeper-evm', new Uint8Array(33)), 'malformed-digest');
    await refused(kms.signDigest('keeper-evm', '11'.repeat(32)), 'malformed-digest');
    // sign() is ed25519 only: a secp256k1 key never signs a message it hashes itself
    await refused(kms.sign('keeper-evm', new Uint8Array([1, 2, 3])), 'wrong-algorithm');
    // a DigestSigner over the key
    const signer = await kmsDigestSigner(kms, 'keeper-evm');
    expect(signer.address).toBe(address);
    const d = '0x' + 'ab'.repeat(32);
    expect(await signer.signDigest(d)).toBe(await kms.signDigest('keeper-evm', d));
  });

  it('cause S4-KMS: the algorithm is configuration: an unknown key id or algorithm is an error, and the id implies nothing', async () => {
    const kms = new LocalKms('seed-not-in-errors', { 'secp-looking-but-ed': 'ed25519', 'plain-name': 'secp256k1' });
    expect((await kms.publicKey('secp-looking-but-ed')).algorithm).toBe('ed25519');
    expect((await kms.publicKey('plain-name')).algorithm).toBe('secp256k1');
    for (const call of [kms.publicKey('keeper-evm'), kms.sign('keeper-evm', new Uint8Array(1)), kms.signerAddress('keeper-evm'), kms.signDigest('keeper-evm', '0x' + '00'.repeat(32))]) { // cause S4-T2: no SPKI export (its only user was the ed25519 verifier key)
      await refused(call, 'unknown-key', 'seed-not-in-errors');
    }
    expect(() => new LocalKms('seed', { k: 'p256' as never })).toThrow(KmsKeyError);
    // two seeds, two keys; one seed, one key per id
    expect(await new LocalKms('other', { 'plain-name': 'secp256k1' }).signerAddress('plain-name')).not.toBe(await kms.signerAddress('plain-name'));
    expect(await new LocalKms('seed-not-in-errors', { 'plain-name': 'secp256k1' }).signerAddress('plain-name')).toBe(await kms.signerAddress('plain-name'));
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
    const acct = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
    const message = signInMessage({ domain: 'merces.test', chain: 'monad', address: acct.address.toLowerCase(), nonce: 'n', issuedAt: 'now' });
    const signature = await acct.signMessage({ message });
    expect(await verifyWalletSignature({ family: 'evm', address: acct.address.toLowerCase(), message, signature })).toBe(true);
    expect(await verifyWalletSignature({ family: 'evm', address: '0x' + '22'.repeat(20), message, signature })).toBe(false);
  });
  it('cause S4-G: personalMessageDigest (the EIP-191 link-proof digest) is viem\'s hashMessage, and a personal_sign recovers through recoverSigner', async () => {
    const acct = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
    const sign = signInMessage({ domain: 'merces.test', chain: 'monad', address: acct.address.toLowerCase(), nonce: 'n', issuedAt: 'now' });
    for (const message of ['', 'hello world', 'é ✓ 漢字', sign, 'x'.repeat(1000)]) expect(personalMessageDigest(message), message.slice(0, 20)).toBe(hashMessage(message));
    const raw = new Uint8Array([0, 1, 2, 0x19, 255]);
    expect(personalMessageDigest(raw)).toBe(hashMessage({ raw }));
    const signature = await acct.signMessage({ message: sign });
    expect(recoverSigner(personalMessageDigest(sign), signature)).toBe(acct.address.toLowerCase());
  });
  it('verifies Solana ed25519 signatures', async () => {
    const kms = new LocalKms('solana-user', { wallet: 'ed25519' }); // cause S4-KMS: explicit algorithm
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

describe('secrets (Part I)', () => {
  const opts = { devDefault: 'dev-session-secret-not-for-production' };
  it('accepts the dev default only while every chain runs on the simulator', () => {
    expect(resolveSecret({}, 'S', { ...opts, simulatorOnly: true })).toBe(opts.devDefault);
    expect(() => resolveSecret({}, 'S', { ...opts, simulatorOnly: false })).toThrow(/must be set/);
    expect(() => resolveSecret({ S: opts.devDefault }, 'S', { ...opts, simulatorOnly: false })).toThrow(/must be set/);
    expect(() => resolveSecret({ S: 'short' }, 'S', { ...opts, simulatorOnly: false })).toThrow(/at least 32/);
    const strong = 'x'.repeat(40);
    expect(resolveSecret({ S: strong }, 'S', { ...opts, simulatorOnly: false })).toBe(strong);
  });
});

describe('report proofs (S1 WP10): Stage 1 Groth16 verifier, proof-system selection, prover artifacts', () => {
  // vector 04's first report: a real Stage 1 Groth16 proof and its six public signals
  const step = (() => {
    const v = JSON.parse(readFileSync(new URL('../../../stage1/packages/vectors/04_zero_quarters.json', import.meta.url), 'utf8')) as { steps: { op: string; proof?: Groth16ProofJson; publicSignals?: string[] }[] };
    const s = v.steps.find((x) => x.op === 'submit_report' && x.proof)!;
    return { proof: s.proof!, signals: s.publicSignals! };
  })();
  afterAll(shutdownProofSystem);

  it('Groth16ReportVerifier: verifies Stage 1 proofs, refuses tampered or malformed ones, caches verdicts per process', async () => {
    const v = new Groth16ReportVerifier();
    expect(v.systems).toEqual(['groth16-bn254']);
    expect(await v.verify(step.proof, step.signals)).toBe(true);
    expect(await new Groth16ReportVerifier().verify(step.proof, [...step.signals])).toBe(true); // a cache hit across instances
    const tampered = [...step.signals];
    tampered[5] = (BigInt(tampered[5]!) + 1n).toString();
    expect(await v.verify(step.proof, tampered)).toBe(false);
    expect(await v.verify({ ...step.proof, pi_a: [step.proof.pi_c[0]!, step.proof.pi_c[1]!, '1'] }, step.signals)).toBe(false);
    expect(await v.verify('0xdeadbeef', step.signals)).toBe(false);
    expect(await v.verify(step.proof, step.signals.slice(0, 5))).toBe(false);
    expect(await v.verify(step.proof, [...step.signals.slice(0, 5), 'x'])).toBe(false);
  });

  it('a process accepts mock proofs only when it says so; MERCES_PROOF_SYSTEM=mock needs a simulator-only process', async () => {
    expect(reportProofSystemFromEnv({}, { simulatorOnly: false })).toBe('groth16-bn254');
    expect(reportProofSystemFromEnv({ MERCES_PROOF_SYSTEM: 'groth16' }, { simulatorOnly: false })).toBe('groth16-bn254');
    expect(reportProofSystemFromEnv({ MERCES_PROOF_SYSTEM: 'mock' }, { simulatorOnly: true })).toBe('mock');
    expect(() => reportProofSystemFromEnv({ MERCES_PROOF_SYSTEM: 'mock' }, { simulatorOnly: false })).toThrow(/refused/);
    expect(() => reportProofSystemFromEnv({ MERCES_PROOF_SYSTEM: 'plonk' }, { simulatorOnly: true })).toThrow(/MERCES_PROOF_SYSTEM/);
    const mock = mockProve(step.signals);
    expect(await new MockProofVerifier().verify(mock, step.signals)).toBe(true);
    const strict = reportProofVerifier({ acceptMock: false });
    expect(strict.systems).toEqual(['groth16-bn254']);
    expect(await strict.verify(mock, step.signals)).toBe(false);
    const dev = reportProofVerifier({ acceptMock: true });
    expect(dev.systems).toEqual(['groth16-bn254', 'mock']);
    expect(await dev.verify(mock, step.signals)).toBe(true);
    expect(await dev.verify(step.proof, step.signals)).toBe(true);
  });

  it('serves Stage 1\'s artifacts, each matching its MANIFEST hash, with the development-setup warning', async () => {
    const a = await stage1ProverArtifacts('/prover');
    expect(a.system).toBe('groth16-bn254');
    expect(a.publicInputLayout).toEqual(['terms_commitment', 'units_outstanding', 'fx_avg_wad', 'prior_income_commitment', 'income_commitment', 'payment_usd']);
    expect(a.wasm).toMatchObject({ url: '/prover/report.wasm', sha256: 'b8bf04593e14fe2093d81d35c9a27c176ab6543303ca3e206ae4806793f111ce' });
    expect(a.zkey).toMatchObject({ url: '/prover/report.zkey', sha256: '52adb06c6537c5c2b82e2aa7f50349ef0766e7bfc4ad4cf3d258ba3de8d28455' });
    expect(a.vkeySha256).toBe('30403351f96ffd60b1c3ce1b13aaa10d8544644b608a9f43b5a8fd05a53df1d2');
    expect(a.vkey).toMatchObject({ protocol: 'groth16', nPublic: 6 });
    expect(a.trustedSetup).toBe('development');
    expect(a.notes).toMatch(/Never mainnet/);
    const wasm = await proverArtifactFile('wasm');
    expect(createHash('sha256').update(wasm.bytes).digest('hex')).toBe(a.wasm.sha256);
    expect(wasm.contentType).toBe('application/wasm');
  });
});

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SECP256K1_N, addressFromPrivateKey, publicKeyFromPrivate, recoverAddress, signDigest } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import {
  KmsKeyError, RemoteSecp256k1Kms, SECP256K1_SPKI_LENGTH, SECP256K1_SPKI_PREFIX_HEX, addressFromSpki, kmsDigestSigner, publicKeyFromSpki, signature65FromDer, signature65FromRs,
  spkiFromPem, type RemoteSecp256k1Provider,
} from '../src/index.ts';

/*
 * S4 cause codes:
 *  - S4-KMS: a cloud KMS's DER signature becomes Stage 1's 65 bytes `r ‖ s ‖ v` (low s, v ∈ {27, 28}, recovering to the
 *    key's address, fail closed), its DER SPKI public key Stage 1's 20-byte address; the provider-neutral adapter.
 */

interface KaMessage { kind: string; digest: string; signer: string; signerAddress: string; signature: string; r: string; s: string; v: number }
const KA = JSON.parse(readFileSync(new URL('../../../stage1/packages/vectors/known_answers.json', import.meta.url), 'utf8')) as { messages: KaMessage[] };
const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const spkiOf = (priv: Uint8Array): Uint8Array => Uint8Array.from(Buffer.concat([Buffer.from(SECP256K1_SPKI_PREFIX_HEX, 'hex'), Buffer.from(publicKeyFromPrivate(priv))]));
const highS = (der: Uint8Array): Uint8Array => {
  const sig = secp256k1.Signature.fromBytes(der, 'der');
  return sig.hasHighS() ? der : new secp256k1.Signature(sig.r, SECP256K1_N - sig.s).toBytes('der');
};

async function refused(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  const e = typeof p === 'function' ? (() => { try { p(); return null; } catch (x) { return x; } })() : await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(KmsKeyError);
  expect((e as KmsKeyError).code).toBe(code);
}

/** A stand-in cloud KMS holding one test key: DER signatures with any s (as no vendor promises low s), a DER SPKI. */
function fakeRemote(seed: string, opts: { spkiOf?: string; sign?: (digest: Uint8Array, priv: Uint8Array, call: number) => Uint8Array } = {}) {
  const priv = deriveTestPrivateKey(seed);
  const calls = { spki: 0, sign: 0 };
  const provider: RemoteSecp256k1Provider = {
    provider: 'fake-kms',
    async getPublicKeySpki() {
      calls.spki++;
      return spkiOf(opts.spkiOf ? deriveTestPrivateKey(opts.spkiOf) : priv);
    },
    async signDigestDer(_keyId, digest) {
      calls.sign++;
      if (opts.sign) return opts.sign(digest, priv, calls.sign);
      // the KMS signs the 32 bytes as given (AWS MessageType=DIGEST) and, like OpenSSL, keeps whatever s comes out
      return highS(secp256k1.sign(digest, priv, { prehash: false, lowS: false, format: 'der' }));
    },
  };
  return { priv, address: hex(addressFromPrivateKey(priv)), calls, provider };
}

describe('the DER normaliser (cause S4-KMS)', () => {
  it('gives each of Stage 1\'s 20 known signatures from its DER, low s and high s alike, and from noble\'s own DER with high s allowed', () => {
    expect(KA.messages).toHaveLength(20);
    let naturalHigh = 0;
    for (const m of KA.messages) {
      const low = new secp256k1.Signature(BigInt(m.r), BigInt(m.s)).toBytes('der');
      const high = new secp256k1.Signature(BigInt(m.r), SECP256K1_N - BigInt(m.s)).toBytes('der');
      expect(signature65FromDer(low, m.digest, m.signerAddress), `${m.kind} low`).toBe(m.signature);
      expect(signature65FromDer(high, m.digest, m.signerAddress), `${m.kind} high`).toBe(m.signature);
      // the digest as bytes, the address in any case
      expect(signature65FromDer(high, bytes(m.digest), m.signerAddress.toUpperCase().replace('0X', '0x'))).toBe(m.signature);
      // noble's DER with lowS: false (what an OpenSSL-like KMS returns); RFC 6979 gives KA's k, so the same (r, ±s)
      const natural = secp256k1.sign(bytes(m.digest), deriveTestPrivateKey(m.signer), { prehash: false, lowS: false, format: 'der' });
      if (secp256k1.Signature.fromBytes(natural, 'der').hasHighS()) naturalHigh++;
      expect(signature65FromDer(natural, m.digest, m.signerAddress), `${m.kind} natural`).toBe(m.signature);
      expect(signature65FromRs(BigInt(m.r), SECP256K1_N - BigInt(m.s), m.digest, m.signerAddress)).toBe(m.signature);
    }
    // the natural set exercises the flip (14 of the 20 have a high s at the pin)
    expect(naturalHigh).toBeGreaterThan(0);
  });

  it('fails closed: another key\'s address, another digest, malformed DER, an out-of-range s', async () => {
    const m = KA.messages[0]!;
    const der = new secp256k1.Signature(BigInt(m.r), BigInt(m.s)).toBytes('der');
    const other = KA.messages.find((x) => x.signerAddress !== m.signerAddress)!;
    await refused(() => signature65FromDer(der, m.digest, other.signerAddress), 'no-recovery');
    await refused(() => signature65FromDer(der, KA.messages[1]!.digest, m.signerAddress), 'no-recovery');
    // strict DER: trailing bytes, a non-minimal integer, a truncated sequence, the compact form
    await refused(() => signature65FromDer(Uint8Array.from([...der, 0]), m.digest, m.signerAddress), 'malformed-signature');
    const padded = Uint8Array.from([0x30, der[1]! + 1, 0x02, der[3]! + 1, 0x00, ...der.subarray(4)]);
    await refused(() => signature65FromDer(padded, m.digest, m.signerAddress), 'malformed-signature');
    await refused(() => signature65FromDer(der.subarray(0, der.length - 1), m.digest, m.signerAddress), 'malformed-signature');
    await refused(() => signature65FromDer(bytes(m.signature).subarray(0, 64), m.digest, m.signerAddress), 'malformed-signature');
    await refused(() => signature65FromRs(BigInt(m.r), 0n, m.digest, m.signerAddress), 'malformed-signature');
    await refused(() => signature65FromRs(BigInt(m.r), SECP256K1_N, m.digest, m.signerAddress), 'malformed-signature');
    await refused(() => signature65FromDer(der, '0x' + '11'.repeat(31), m.signerAddress), 'malformed-digest');
    await refused(() => signature65FromDer(der, m.digest, '0x1234'), 'malformed-public-key');
  });

  it('regression pin: noble\'s defaults are not Stage 1\'s (prehash is sha256, and "recovered" is recid ‖ r ‖ s)', () => {
    const m = KA.messages[0]!;
    const priv = deriveTestPrivateKey(m.signer);
    // prehash defaults to true: noble signs sha256(digest), a different message, which recovers to another address
    const prehashed = secp256k1.sign(bytes(m.digest), priv, { format: 'recovered' });
    const asStage1 = Uint8Array.from([...prehashed.subarray(1), 27 + prehashed[0]!]);
    expect(hex(asStage1)).not.toBe(m.signature);
    expect(hex(recoverAddress(m.digest, asStage1))).not.toBe(m.signerAddress);
    // with prehash: false it is Stage 1's signature, reordered from recid ‖ r ‖ s to r ‖ s ‖ (27 + recid)
    const raw = secp256k1.sign(bytes(m.digest), priv, { prehash: false, format: 'recovered' });
    expect([0, 1]).toContain(raw[0]);
    expect(hex(Uint8Array.from([...raw.subarray(1), 27 + raw[0]!]))).toBe(m.signature);
    expect(hex(signDigest(m.digest, priv).bytes)).toBe(m.signature);
  });
});

describe('the SPKI address (cause S4-KMS)', () => {
  it('reads a secp256k1 SPKI (Node\'s own export agrees with the 23-byte prefix) and gives Stage 1\'s address', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const der = Uint8Array.from(publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
    expect(der.length).toBe(SECP256K1_SPKI_LENGTH);
    expect(Buffer.from(der.subarray(0, 23)).toString('hex')).toBe(SECP256K1_SPKI_PREFIX_HEX);
    expect(publicKeyFromSpki(der)).toEqual(der.subarray(23));
    const pem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    expect(spkiFromPem(pem)).toEqual(der);
    for (const seed of ['attestor1', 'verifier1', 'merces-local-kms:x:y']) {
      const priv = deriveTestPrivateKey(seed);
      expect(addressFromSpki(spkiOf(priv))).toBe(hex(addressFromPrivateKey(priv)));
    }
  });

  it('refuses any other key: P-256, ed25519, a wrong length, a point off the curve, a compressed point, a non-PEM', async () => {
    const p256 = Uint8Array.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
    expect(p256.length).toBe(91);
    await refused(() => addressFromSpki(p256), 'malformed-public-key');
    const ed = Uint8Array.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
    await refused(() => addressFromSpki(ed), 'malformed-public-key');
    const good = spkiOf(deriveTestPrivateKey('attestor1'));
    await refused(() => addressFromSpki(good.subarray(0, 87)), 'malformed-public-key');
    const offCurve = Uint8Array.from(good);
    offCurve[87] = offCurve[87]! ^ 1;
    await refused(() => addressFromSpki(offCurve), 'malformed-public-key');
    const notUncompressed = Uint8Array.from(good);
    notUncompressed[23] = 0x02;
    await refused(() => addressFromSpki(notUncompressed), 'malformed-public-key');
    await refused(() => spkiFromPem('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), 'malformed-public-key');
  });
});

describe('RemoteSecp256k1Kms, the provider-neutral adapter (cause S4-KMS)', () => {
  it('normalises a remote KMS\'s high-s DER to Stage 1\'s signature, caches the address and is a DigestSigner', async () => {
    const remote = fakeRemote('remote-key');
    const kms = new RemoteSecp256k1Kms(remote.provider);
    expect(kms.provider).toBe('fake-kms');
    expect(await kms.signerAddress('rv')).toBe(remote.address);
    expect(await kms.publicKey('rv')).toEqual({ algorithm: 'secp256k1', publicKeyHex: Buffer.from(publicKeyFromPrivate(remote.priv)).toString('hex') });
    for (const m of KA.messages.slice(0, 6)) {
      const sig = await kms.signDigest('rv', m.digest);
      // the same signature Stage 1's signDigest gives with that key (RFC 6979 k, then low s and v)
      expect(sig).toBe(hex(signDigest(m.digest, remote.priv).bytes));
    }
    expect(remote.calls).toEqual({ spki: 1, sign: 6 });
    const signer = await kmsDigestSigner(kms, 'rv');
    expect(signer.address).toBe(remote.address);
    expect(await signer.signDigest(KA.messages[0]!.digest)).toBe(hex(signDigest(KA.messages[0]!.digest, remote.priv).bytes));
    // ed25519 calls are refused: the adapter holds secp256k1 keys only
    await refused(kms.sign('rv'), 'wrong-algorithm');
    await refused(kms.signDigest('rv', '0x00'), 'malformed-digest');
  });

  it('fails closed when the public key is not the signing key (after one more signature), and on malformed DER (at once)', async () => {
    const wrong = fakeRemote('signing-key', { spkiOf: 'some-other-key' });
    await refused(new RemoteSecp256k1Kms(wrong.provider).signDigest('rv', KA.messages[0]!.digest), 'no-recovery');
    expect(wrong.calls.sign).toBe(2);
    const garbage = fakeRemote('k', { sign: () => Uint8Array.from([0x30, 0x00]) });
    await refused(new RemoteSecp256k1Kms(garbage.provider).signDigest('rv', KA.messages[0]!.digest), 'malformed-signature');
    expect(garbage.calls.sign).toBe(1);
  });

  it('asks once more when a signature fits neither recovery id, and keeps the second', async () => {
    const digest = KA.messages[2]!.digest;
    const flaky = fakeRemote('flaky', {
      // first answer: a signature over another digest (recovers elsewhere); then the right one
      sign: (d, priv, call) => secp256k1.sign(call === 1 ? new Uint8Array(32).fill(7) : d, priv, { prehash: false, lowS: false, format: 'der' }),
    });
    const kms = new RemoteSecp256k1Kms(flaky.provider);
    expect(await kms.signDigest('rv', digest)).toBe(hex(signDigest(digest, flaky.priv).bytes));
    expect(flaky.calls.sign).toBe(2);
  });

  it('does not cache a failed public-key read', async () => {
    let fail = true;
    const priv = deriveTestPrivateKey('late-key');
    const kms = new RemoteSecp256k1Kms({
      provider: 'fake-kms',
      async getPublicKeySpki() {
        if (fail) throw new Error('KMS unavailable');
        return spkiOf(priv);
      },
      async signDigestDer() {
        throw new Error('not called');
      },
    });
    await expect(kms.signerAddress('rv')).rejects.toThrow('KMS unavailable');
    fail = false;
    expect(await kms.signerAddress('rv')).toBe(hex(addressFromPrivateKey(priv)));
  });
});

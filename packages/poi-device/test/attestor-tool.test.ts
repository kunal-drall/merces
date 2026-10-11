import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { SigningError, pauseDigest, personalMessageDigest, seriesKeyOf, signature65Hex, signingDomain, signingRequest, type SigningDomain, type SigningFields, type SigningKind } from '@merces/domain';
import { addressFromPrivateKey, keccak256, signDigest, verifySignature } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { signerKeyLinkMessage, verifyKeyPersonalSignature } from '@merces/ports';
import { SimulatorChain, deriveAddress } from '@merces/simulator';
import {
  AttestorKey, AttestorToolError, CANNOT_BE_RECALLED, KEYSTORE_SCRYPT_N, KeystoreError, checkLinkChallenge, checkRequest, createKeystore, decryptKeystore, describeSigningRequest,
  linkProof, pinNetworks, signChecked, signRequest, type CheckedSigningRequest, type PinnedNetworks,
} from '../src/index.ts';
import { TEST_SCRYPT_N_ENV, main, readHiddenLine, type CliIo } from '../src/attestor-cli.ts';

/*
 * S4 cause codes:
 *  - S4-DEV: the attestor device tool (S4 WP8, D2 and amendment fix 4): the keystore, the request check against the
 *    device's pinned network table, the display built from typed fields, signing, the link proof and the CLI.
 * The key below is a published TEST key (Stage 1's `deriveTestPrivateKey` of a labelled seed): never a real one.
 */

const HARNESS = { VITEST: 'true' } as const;
const PRODUCTION = {} as const;
const PW = 'correct horse battery staple';
const PRIV = deriveTestPrivateKey('merces-s4-dev:attestor-1');
const PRIV_HEX = Buffer.from(PRIV).toString('hex');
const key = AttestorKey.fromPrivateKey(PRIV);
const other = AttestorKey.fromPrivateKey(deriveTestPrivateKey('merces-s4-dev:attestor-2'));
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const sdkSign = (digest: string) => signature65Hex(signDigest(digest, PRIV));

const monad = signingDomain('evm', 10143, '0x' + '42'.repeat(20)); // Monad Testnet, a made-up registry
const solRegistry = deriveAddress('solana', 'program:merces_registry:s4-dev');
const devnet = signingDomain('solana', 103, solRegistry);
const pinned: PinnedNetworks = pinNetworks({ monad, solana: { family: 'solana', chainId: 103, registry: solRegistry } });
const monadSeries = `monad:0x${'ab'.repeat(20)}`;
const solSeries = `solana:${deriveAddress('solana', 'series:s4-dev')}`;
const C = (n: number) => '0x' + n.toString(16).padStart(64, '0');

const FIELDS: { [K in SigningKind]: SigningFields[K] } = {
  REPORT: { periodId: '2026Q3', priorIncomeCommitment: C(1), incomeCommitment: C(2), tier: 3, liquidityEvent: false },
  FX: { periodId: '2026Q3', fxRateWad: '1085000000000000000' },
  AMEND: { amendmentNonce: '2', termsCommitment: C(3), capMultipleWad: '2500000000000000000' },
  PAUSE: { pauseNonce: '3', pauseEnd: '1798761600' },
  EXTINGUISH: { extinguishNonce: '0' },
  TRUEUP: { trueupNonce: '1', year: 2026, adjustment: '-1250000', attestationTs: '1798761600' },
};
function request<K extends SigningKind>(kind: K, over: { chain?: string; seriesId?: string; domain?: SigningDomain; signer?: string; fields?: SigningFields[K] } = {}) {
  const chain = over.chain ?? 'monad';
  const seriesId = over.seriesId ?? (chain === 'solana' ? solSeries : monadSeries);
  const domain = over.domain ?? (chain === 'solana' ? devnet : monad);
  return signingRequest({ kind, chain, seriesId, seriesKey: seriesKeyOf(seriesId, domain.chainKind === 1 ? 'solana' : 'evm'), domain, signer: over.signer ?? key.address, fields: over.fields ?? FIELDS[kind] });
}
async function rejectsWith(p: Promise<unknown> | (() => unknown), code: string): Promise<Error> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a refusal with ${code}`);
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'merces-attestor-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the keystore

describe('attestor keystore: Web3 Secret Storage v3 (S4-DEV)', () => {
  it('round-trips at the test strength in go-ethereum\'s v3 shape, with a fresh salt, IV and id each time, and no key in the file', async () => {
    const ks = await createKeystore(key, PW, { scryptN: 16, env: HARNESS });
    expect(ks).toMatchObject({ address: key.address.slice(2), version: 3, crypto: { cipher: 'aes-128-ctr', kdf: 'scrypt', kdfparams: { dklen: 32, n: 16, p: 1, r: 8 } } });
    expect(ks.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ks.crypto.ciphertext).toMatch(/^[0-9a-f]{64}$/);
    expect(ks.crypto.cipherparams.iv).toMatch(/^[0-9a-f]{32}$/);
    expect(ks.crypto.mac).toMatch(/^[0-9a-f]{64}$/);
    expect((ks.crypto.kdfparams as { salt: string }).salt).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ks).toLowerCase()).not.toContain(PRIV_HEX);
    expect((await decryptKeystore(ks, PW, { env: HARNESS })).address).toBe(key.address);
    expect((await decryptKeystore(JSON.stringify(ks), PW, { env: HARNESS })).address).toBe(key.address);
    const again = await createKeystore(key, PW, { scryptN: 16, env: HARNESS });
    expect(again.id).not.toBe(ks.id);
    expect(again.crypto.cipherparams.iv).not.toBe(ks.crypto.cipherparams.iv);
    expect(again.crypto.ciphertext).not.toBe(ks.crypto.ciphertext);
  });

  it('refuses a wrong password, a tampered MAC or ciphertext (wrong-password), a tampered IV or address (address-mismatch), naming no secret', async () => {
    const ks = await createKeystore(key, PW, { scryptN: 16, env: HARNESS });
    const flip = (h: string) => (h[0] === '0' ? '1' : '0') + h.slice(1);
    const wrong = await rejectsWith(decryptKeystore(ks, 'not the password at all', { env: HARNESS }), 'wrong-password');
    expect(wrong.message).not.toContain('not the password at all');
    await rejectsWith(decryptKeystore({ ...ks, crypto: { ...ks.crypto, mac: flip(ks.crypto.mac) } }, PW, { env: HARNESS }), 'wrong-password');
    await rejectsWith(decryptKeystore({ ...ks, crypto: { ...ks.crypto, ciphertext: flip(ks.crypto.ciphertext) } }, PW, { env: HARNESS }), 'wrong-password');
    // the MAC covers the ciphertext only (the v3 definition); a changed IV decrypts to another key, which the address field catches
    await rejectsWith(decryptKeystore({ ...ks, crypto: { ...ks.crypto, cipherparams: { iv: flip(ks.crypto.cipherparams.iv) } } }, PW, { env: HARNESS }), 'address-mismatch');
    await rejectsWith(decryptKeystore({ ...ks, address: other.address.slice(2) }, PW, { env: HARNESS }), 'address-mismatch');
    await rejectsWith(decryptKeystore({ ...ks, version: 1 }, PW, { env: HARNESS }), 'unsupported');
    await rejectsWith(decryptKeystore({ ...ks, crypto: { ...ks.crypto, cipher: 'aes-128-cbc' } }, PW, { env: HARNESS }), 'unsupported');
    await rejectsWith(decryptKeystore('{"version": 3', PW, { env: HARNESS }), 'malformed');
    await rejectsWith(decryptKeystore({ ...ks, crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 1 << 22 } } }, PW, { env: HARNESS }), 'unsupported');
  });

  it('decrypts the official test vectors: ethereum.org\'s PBKDF2 vector and go-ethereum\'s (wiki scrypt, 31- and 30-byte keys)', async () => {
    // ethereum.org web3-secret-storage/index.md (VERSIONS.md "Attestor device tool"): PBKDF2-SHA-256, address 008aeeda…
    const pbkdf2 = {
      crypto: {
        cipher: 'aes-128-ctr', cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' }, ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46', kdf: 'pbkdf2',
        kdfparams: { c: 262144, dklen: 32, prf: 'hmac-sha256', salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd' }, mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
      },
      id: '3198bc9c-6672-5ab3-d995-4942343ae5b6', version: 3,
    };
    expect((await decryptKeystore(pbkdf2, 'testpassword', { allowWeakKdf: true, env: PRODUCTION })).address).toBe('0x008aeeda4d805471df9b2a5b0f38a0c3bcba786b');
    // a PBKDF2 keystore is only ever an import source: the tool signs with its own scrypt keystores
    await rejectsWith(decryptKeystore(pbkdf2, 'testpassword', { env: PRODUCTION }), 'weak-kdf');
    // go-ethereum v1.17.8 accounts/keystore/testdata/v3_test_vector.json: "wikipage_test_vector_scrypt" (n 2^18, r 1, p 8)
    const scrypt = {
      crypto: {
        cipher: 'aes-128-ctr', cipherparams: { iv: '83dbcc02d8ccb40e466191a123791e0e' }, ciphertext: 'd172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c', kdf: 'scrypt',
        kdfparams: { dklen: 32, n: 262144, r: 1, p: 8, salt: 'ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19' }, mac: '2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097',
      },
      id: '3198bc9c-6672-5ab3-d995-4942343ae5b6', version: 3,
    };
    expect((await decryptKeystore(scrypt, 'testpassword', { env: PRODUCTION })).address).toBe('0x008aeeda4d805471df9b2a5b0f38a0c3bcba786b');
    // "31_byte_key" and "30_byte_key" (n 2): old keystores dropped leading zero bytes; the key is left-padded
    const short = (iv: string, ct: string, salt: string, mac: string, id: string) => ({ crypto: { cipher: 'aes-128-ctr', cipherparams: { iv }, ciphertext: ct, kdf: 'scrypt', kdfparams: { dklen: 32, n: 2, r: 8, p: 1, salt }, mac }, id, version: 3 });
    const k31 = await decryptKeystore(short('e0c41130a323adc1446fc82f724bca2f', '9517cd5bdbe69076f9bf5057248c6c050141e970efa36ce53692d5d59a3984', '711f816911c92d649fb4c84b047915679933555030b3552c1212609b38208c63', 'd5e116151c6aa71470e67a7d42c9620c75c4d23229847dcc127794f0732b0db5', 'fecfc4ce-e956-48fd-953b-30f8b52ed66c'), 'foo', { allowWeakKdf: true, env: PRODUCTION });
    expect(k31.address).toBe(hex(addressFromPrivateKey('0x00fa7b3db73dc7dfdf8c5fbdb796d741e4488628c41fc4febd9160a866ba0f35')));
    const k30 = await decryptKeystore(short('3ca92af36ad7c2cd92454c59cea5ef00', '108b7d34f3442fc26ab1ab90ca91476ba6bfa8c00975a49ef9051dc675aa', 'd0769e608fb86cda848065642a9c6fa046845c928175662b8e356c77f914cd3b', '75d0e6759f7b3cefa319c3be41680ab6beea7d8328653474bd06706d4cc67420', 'a37e1559-5955-450d-8075-7b8931b392b2'), 'foo', { allowWeakKdf: true, env: PRODUCTION });
    expect(k30.address).toBe(hex(addressFromPrivateKey('0x000081c29e8142bb6a81bef5a92bda7a8328a5c85bb2f9542e76f9b0f94fc018')));
  });

  it('ethereum.org\'s scrypt vector does not reproduce: its kdfparams do not give its stated derived key (recorded in VERSIONS.md)', async () => {
    const page = {
      crypto: {
        cipher: 'aes-128-ctr', cipherparams: { iv: '740770fce12ce862af21264dab25f1da' }, ciphertext: 'dd8a1132cf57db67c038c6763afe2cbe6ea1949a86abc5843f8ca656ebbb1ea2', kdf: 'scrypt',
        kdfparams: { dklen: 32, n: 262144, p: 1, r: 8, salt: '25710c2ccd7c610b24d068af83b959b7a0e5f40641f0c82daeb1345766191034' }, mac: '337aeb86505d2d0bb620effe57f18381377d67d76dac1090626aa5cd20886a7c',
      },
      id: '3198bc9c-6672-5ab3-d995-4942343ae5b6', version: 3,
    };
    await rejectsWith(decryptKeystore(page, 'testpassword', { env: PRODUCTION }), 'wrong-password');
    // the page's stated intermediates agree with each other: its derived key gives its MAC and decrypts to its secret
    const dk = Buffer.from('7446f59ecc301d2d79bc3302650d8a5cedc185ccbb4bf3ca1ebd2c163eaa6c2d', 'hex');
    const ct = Buffer.from(page.crypto.ciphertext, 'hex');
    expect(hex(keccak256(dk.subarray(16, 32), ct))).toBe('0x' + page.crypto.mac);
    const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), Buffer.from(page.crypto.cipherparams.iv, 'hex'));
    expect(Buffer.concat([d.update(ct), d.final()]).toString('hex')).toBe('7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d');
  });

  it('no production path makes or uses a weak keystore: scrypt n below 2^18 only under the test harness; short passwords refused', async () => {
    await rejectsWith(createKeystore(key, PW, { scryptN: 16, env: PRODUCTION }), 'weak-kdf');
    await rejectsWith(createKeystore(key, PW, { scryptN: 1 << 17, env: PRODUCTION }), 'weak-kdf');
    await rejectsWith(createKeystore(key, PW, { scryptN: 100, env: HARNESS }), 'unsupported');
    await rejectsWith(createKeystore(key, 'short', { scryptN: 16, env: HARNESS }), 'weak-password');
    const weak = await createKeystore(key, PW, { scryptN: 16, env: { NODE_ENV: 'test' } });
    await rejectsWith(decryptKeystore(weak, PW, { env: PRODUCTION }), 'weak-kdf');
    expect((await decryptKeystore(weak, PW, { allowWeakKdf: true, env: PRODUCTION })).address).toBe(key.address);
    // the default is the standard strength, and a production run reads it
    const standard = await createKeystore(key, PW, { env: PRODUCTION });
    expect(standard.crypto.kdfparams).toMatchObject({ n: KEYSTORE_SCRYPT_N, r: 8, p: 1, dklen: 32 });
    expect(KEYSTORE_SCRYPT_N).toBe(262144);
    expect((await decryptKeystore(standard, PW, { env: PRODUCTION })).address).toBe(key.address);
  });

  it('an AttestorKey shows its address only, and a wiped key signs nothing', () => {
    const k = AttestorKey.fromPrivateKey(PRIV);
    for (const shown of [JSON.stringify(k), String(k), inspect(k), inspect({ k }, { depth: 5, showHidden: true })]) {
      expect(shown.toLowerCase()).not.toContain(PRIV_HEX);
      expect(shown).toContain(k.address);
    }
    k.wipe();
    expect(() => signRequest(request('PAUSE'), k, pinned)).toThrow(KeystoreError);
    expect(() => AttestorKey.fromPrivateKey(new Uint8Array(32))).toThrow(KeystoreError);
    expect(() => AttestorKey.fromPrivateKey(new Uint8Array(32).fill(0xff))).toThrow(KeystoreError);
    expect(AttestorKey.generate().address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------- requests

describe('attestor signer: the request check on the device and signing (S4-DEV)', () => {
  it('signs every attestor message with Stage 1\'s signDigest over the digest it rebuilt, recovering to the key', () => {
    for (const kind of ['REPORT', 'FX', 'AMEND', 'PAUSE', 'EXTINGUISH', 'TRUEUP'] as const) {
      for (const chain of ['monad', 'solana']) {
        const req = request(kind, { chain });
        const s = signRequest(req, key, pinned);
        expect(s).toEqual({ signer: key.address, signature: sdkSign(req.digest), digest: req.digest });
        expect(verifySignature(req.digest, s.signature, key.address)).toBe(true);
      }
    }
  });

  it('refuses a digest or pre-image that is not the typed fields\', a field edit, an unknown kind and a request carrying text', async () => {
    const req = request('PAUSE');
    await rejectsWith(() => checkRequest({ ...req, digest: request('PAUSE', { fields: { pauseNonce: '4', pauseEnd: '1798761600' } }).digest }, pinned), 'digest-mismatch');
    await rejectsWith(() => checkRequest({ ...req, fields: { ...req.fields, pauseEnd: '1798761601' } }, pinned), 'digest-mismatch');
    await rejectsWith(() => checkRequest({ ...req, preimage: req.preimage.slice(0, -2) + '00' }, pinned), 'digest-mismatch');
    await rejectsWith(() => checkRequest({ ...req, kind: 'TRANSFER' }, pinned), 'malformed');
    await rejectsWith(() => checkRequest({ ...req, display: 'Routine check: sign this' }, pinned), 'malformed');
    await rejectsWith(() => checkRequest({ ...req, validWhile: 'forever' }, pinned), 'malformed');
    await rejectsWith(() => checkRequest({ ...req, seriesId: `monad:0x${'cd'.repeat(20)}` }, pinned), 'series-mismatch');
    await rejectsWith(() => checkRequest(request('REPORT', { fields: { ...FIELDS.REPORT, tier: 2 } }), pinned), 'not-attestor-message');
  });

  it('refuses a chain the device has not pinned, another domain on a pinned chain, and every mainnet (chain ids 101 and 143)', async () => {
    const sepolia = signingDomain('evm', 84532, '0x' + '42'.repeat(20));
    await rejectsWith(() => checkRequest(request('PAUSE', { chain: 'base-sepolia', seriesId: `base-sepolia:0x${'ab'.repeat(20)}`, domain: sepolia }), pinned), 'unpinned-chain');
    await rejectsWith(() => checkRequest(request('PAUSE', { domain: signingDomain('evm', 10143, '0x' + '43'.repeat(20)) }), pinned), 'domain-mismatch');
    await rejectsWith(() => checkRequest(request('PAUSE', { domain: sepolia }), pinned), 'domain-mismatch');
    // the pinned table itself refuses a mainnet, by name, in either form
    await rejectsWith(() => pinNetworks({ solana: { family: 'solana', chainId: 101, registry: solRegistry } }), 'mainnet');
    await rejectsWith(() => pinNetworks({ monad: { family: 'evm', chainId: 143, registry: '0x' + '42'.repeat(20) } }), 'mainnet');
    await rejectsWith(() => pinNetworks({ monad: signingDomain('evm', 143, '0x' + '42'.repeat(20)) }), 'mainnet');
    await rejectsWith(() => pinNetworks({ monad: { ...monad, domain: C(9) } }), 'domain-mismatch');
    await rejectsWith(() => pinNetworks({ monad: { family: 'evm', chainId: 10143, registry: '0x' + '42'.repeat(20), domain: C(9) } }), 'networks');
    await rejectsWith(() => pinNetworks({}), 'networks');
    // and a mainnet that reaches the check another way is refused there too
    for (const main of [signingDomain('evm', 143, '0x' + '42'.repeat(20)), signingDomain('solana', 101, solRegistry)]) {
      const chain = main.chainKind === 1 ? 'solana' : 'monad';
      const seriesId = chain === 'solana' ? solSeries : monadSeries;
      const seriesKey = seriesKeyOf(seriesId, main.chainKind === 1 ? 'solana' : 'evm');
      const m = pauseDigest({ domain: main.domain, seriesKey }, FIELDS.PAUSE);
      const forged = { kind: 'PAUSE', chain, seriesId, seriesKey, domain: main, signer: key.address, fields: FIELDS.PAUSE, preimage: m.preimage, digest: m.digest, validWhile: 'pause nonce 3' };
      await rejectsWith(() => checkRequest(forged, { [chain]: main } as PinnedNetworks), 'mainnet');
    }
    // the simulator's local ids only with allowLocal
    const local = signingDomain('evm', 31337, '0x' + '42'.repeat(20));
    await rejectsWith(() => pinNetworks({ monad: local }), 'network-not-allowed');
    const localPinned = pinNetworks({ monad: local }, { allowLocal: true });
    await rejectsWith(() => checkRequest(request('PAUSE', { domain: local }), localPinned), 'network-not-allowed');
    expect(signRequest(request('PAUSE', { domain: local }), key, localPinned, { allowLocal: true }).signer).toBe(key.address);
  });

  it('pins a simulator chain from its ChainInfo.signing in development (local ids with allowLocal only)', async () => {
    for (const personality of ['solana', 'monad'] as const) {
      const sim = SimulatorChain.createSync({ personality });
      const signing = (await sim.info()).signing!;
      const family = personality === 'solana' ? 'solana' : 'evm';
      const seriesId = `${sim.chain}:${personality === 'solana' ? deriveAddress('solana', 'series:s4-dev-sim') : `0x${'ab'.repeat(20)}`}`;
      const req = signingRequest({ kind: 'EXTINGUISH', chain: sim.chain, seriesId, seriesKey: seriesKeyOf(seriesId, family), domain: signing, signer: key.address, fields: { extinguishNonce: '0' } });
      expect(signRequest(req, key, pinNetworks({ [sim.chain]: signing }, { allowLocal: true }), { allowLocal: true }).signature).toBe(sdkSign(req.digest));
      expect(() => pinNetworks({ [sim.chain]: signing })).toThrow(SigningError);
    }
  });

  it('signs only a request it checked, and only with the key the request names', async () => {
    const c = checkRequest(request('AMEND', { signer: other.address }), pinned);
    await rejectsWith(() => signChecked(c, key), 'wrong-key');
    expect(signChecked(c, other).signer).toBe(other.address);
    const forged = { ...checkRequest(request('AMEND'), pinned), digest: C(7) } as CheckedSigningRequest;
    await rejectsWith(() => signChecked(forged, key), 'not-checked');
    expect(Object.isFrozen(c) && Object.isFrozen(c.fields) && Object.isFrozen(c.domain)).toBe(true);
  });

  it('builds its display from the typed fields and its own pin, and warns before a PAUSE or an EXTINGUISH that it cannot be recalled', () => {
    const show = (kind: SigningKind, chain = 'monad') => describeSigningRequest(checkRequest(request(kind, { chain }), pinned)).join('\n');
    const pause = show('PAUSE');
    expect(pause).toContain('pause nonce 3');
    expect(pause).toContain('2027-01-01T00:00:00.000Z');
    expect(pause).toContain('Monad Testnet (chain id 10143)');
    expect(pause).toContain(monadSeries);
    expect(pause).toContain(request('PAUSE').digest);
    expect(pause).toContain(`WARNING: ${CANNOT_BE_RECALLED}`);
    expect(CANNOT_BE_RECALLED).toMatch(/cannot be recalled.*anyone.*until it is used or this key is revoked/i);
    expect(show('EXTINGUISH', 'solana')).toContain(CANNOT_BE_RECALLED);
    expect(show('EXTINGUISH', 'solana')).toContain('Solana devnet (cluster tag 103)');
    for (const kind of ['REPORT', 'FX', 'AMEND', 'TRUEUP'] as const) expect(show(kind)).not.toContain(CANNOT_BE_RECALLED);
    expect(show('FX')).toContain('1.085');
    expect(show('AMEND')).toContain('2.5×');
    expect(show('TRUEUP')).toContain('-1.25');
    expect(show('REPORT')).toContain('liquidity event         no');
    // the nonce cannot be checked against the chain yet (S5): said for every nonce-bound kind, not for REPORT and FX
    for (const kind of ['AMEND', 'PAUSE', 'EXTINGUISH', 'TRUEUP'] as const) expect(show(kind)).toContain('cannot check it against the chain yet');
    for (const kind of ['REPORT', 'FX'] as const) expect(show(kind)).not.toContain('cannot check it against the chain yet');
  });
});

// ---------------------------------------------------------------- link proofs

describe('attestor link proof: EIP-191 over the API\'s key-link challenge only (S4-DEV)', () => {
  const challenge = (address = key.address) => signerKeyLinkMessage({ domain: 'api.merces.test', accountId: 'acct-1', address, nonce: 'ab'.repeat(16), issuedAt: '2026-10-11T09:00:00.000Z' });

  it('signs the challenge as personal_sign: viem verifies it, and it is Stage 1\'s signDigest over the EIP-191 digest', async () => {
    const proof = linkProof(challenge(), key);
    expect(proof).toEqual({ address: key.address, nonce: 'ab'.repeat(16), signature: sdkSign(personalMessageDigest(challenge())) });
    expect(await verifyKeyPersonalSignature({ address: key.address, message: challenge(), signature: proof.signature })).toBe(true);
    expect(linkProof(`${challenge()}\n`, key)).toEqual(proof); // a file saved from the API's message
    expect(checkLinkChallenge(challenge(), key.address)).toEqual({ host: 'api.merces.test', accountId: 'acct-1', address: key.address, nonce: 'ab'.repeat(16), issuedAt: '2026-10-11T09:00:00.000Z' });
  });

  it('refuses another key\'s challenge and any other text', async () => {
    await rejectsWith(() => linkProof(challenge(other.address), key), 'wrong-key');
    await rejectsWith(() => linkProof('Sign in to example.com\nNonce: 1', key), 'not-link-challenge');
    await rejectsWith(() => linkProof(challenge().replace('moves no funds', 'moves funds'), key), 'not-link-challenge');
    await rejectsWith(() => linkProof(`${challenge()}\nTransfer 10 ETH`, key), 'not-link-challenge');
    await rejectsWith(() => linkProof(challenge().replace('Nonce: ', 'Nonce:  '), key), 'not-link-challenge');
  });
});

// ---------------------------------------------------------------- the CLI

function cliIo(env: Record<string, string>, opts: { confirm?: boolean; password?: (prompt: string) => Promise<string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    env,
    readPassword: opts.password ?? (() => Promise.reject(new Error('no terminal in this test'))),
    confirm: async () => opts.confirm ?? false,
  };
  return { io, out, err, all: () => [...out, ...err].join('\n') };
}

describe('merces-attestor CLI: a smoke test in a temporary directory (S4-DEV)', () => {
  it('import, address, link and sign end to end; files are 0600; the private key is never printed', async () => {
    const d = tmp();
    const env = { ...HARNESS, HOME: d, [TEST_SCRYPT_N_ENV]: '16', ATTESTOR_PW: PW };
    const ks = join(d, 'keys', 'attestor.json');
    const keyFile = join(d, 'key.txt');
    writeFileSync(keyFile, `0x${PRIV_HEX}\n`);
    const pw = ['--keystore', ks, '--password-env', 'ATTESTOR_PW'];
    const transcript: string[] = [];
    const run = async (argv: string[], io = cliIo(env)) => {
      const code = await main(argv, io.io);
      transcript.push(io.all());
      return { code, out: io.out.join(''), err: io.err.join('\n') };
    };

    const imported = await run(['import', keyFile, ...pw]);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.out)).toEqual({ address: key.address, checksumAddress: key.checksumAddress, keystore: ks });
    expect(imported.err).toContain('delete that file securely');
    expect(imported.err).toContain('/proc');
    expect(statSync(ks).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'keys')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(ks, 'utf8')).crypto.kdfparams.n).toBe(16);

    expect(JSON.parse((await run(['address', ...pw])).out)).toEqual({ address: key.address, checksumAddress: key.checksumAddress });

    const challenge = signerKeyLinkMessage({ domain: 'api.merces.test', accountId: 'acct-1', address: key.address, nonce: 'cd'.repeat(16), issuedAt: '2026-10-11T09:00:00.000Z' });
    writeFileSync(join(d, 'challenge.txt'), `${challenge}\n`);
    const linked = await run(['link', join(d, 'challenge.txt'), '--yes', ...pw]);
    expect(linked.code).toBe(0);
    const body = JSON.parse(linked.out) as { address: string; nonce: string; signature: string };
    expect(body).toMatchObject({ address: key.address, nonce: 'cd'.repeat(16) });
    expect(await verifyKeyPersonalSignature({ address: key.address, message: challenge, signature: body.signature })).toBe(true);
    expect(linked.err).toContain('not an attestation');

    writeFileSync(join(d, 'networks.json'), JSON.stringify({ monad, solana: { family: 'solana', chainId: 103, registry: solRegistry } }));
    const nets = ['--networks', join(d, 'networks.json')];
    writeFileSync(join(d, 'pause.json'), JSON.stringify(request('PAUSE')));
    const signed = await run(['sign', join(d, 'pause.json'), '--yes', ...nets, ...pw]);
    expect(signed.code).toBe(0);
    expect(JSON.parse(signed.out)).toEqual({ kind: 'PAUSE', chain: 'monad', seriesId: monadSeries, signer: key.address, signature: sdkSign(request('PAUSE').digest), digest: request('PAUSE').digest });
    expect(signed.err).toContain(CANNOT_BE_RECALLED);

    // a list (FX for two series), written to a 0600 file
    const fxList = [request('FX'), request('FX', { chain: 'solana' })];
    writeFileSync(join(d, 'fx.json'), JSON.stringify(fxList));
    const out = join(d, 'out', 'fx-signatures.json');
    const listed = await run(['sign', join(d, 'fx.json'), '--yes', '--out', out, ...nets, ...pw]);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe('');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { signature: string }[]).map((s) => s.signature)).toEqual(fxList.map((r) => sdkSign(r.digest)));
    expect(listed.err).not.toContain(CANNOT_BE_RECALLED);

    // refusals: nothing signed, nothing on stdout
    writeFileSync(join(d, 'tampered.json'), JSON.stringify({ ...request('PAUSE'), fields: { pauseNonce: '3', pauseEnd: '1' } }));
    const tampered = await run(['sign', join(d, 'tampered.json'), '--yes', ...nets, ...pw]);
    expect([tampered.code, tampered.out]).toEqual([1, '']);
    expect(tampered.err).toContain('digest-mismatch');
    const declined = await run(['sign', join(d, 'pause.json'), ...nets, ...pw]);
    expect([declined.code, declined.out]).toEqual([1, '']);
    expect(declined.err).toContain('declined');
    writeFileSync(join(d, 'mainnet.json'), JSON.stringify({ monad: { family: 'evm', chainId: 143, registry: '0x' + '42'.repeat(20) } }));
    const mainnet = await run(['sign', join(d, 'pause.json'), '--yes', '--networks', join(d, 'mainnet.json'), ...pw]);
    expect([mainnet.code, mainnet.out]).toEqual([1, '']);
    expect(mainnet.err).toContain('mainnet');
    const wrongPw = await run(['address', '--keystore', ks, '--password-env', 'WRONG'], cliIo({ ...env, WRONG: 'hunter2-not-it' }));
    expect(wrongPw.code).toBe(1);
    expect(wrongPw.err).toContain('wrong-password');
    expect(wrongPw.err).not.toContain('hunter2-not-it');

    // keygen: a new key, never over an existing keystore
    const ks2 = join(d, 'keys', 'second.json');
    const made = await run(['keygen', '--keystore', ks2, '--password-env', 'ATTESTOR_PW']);
    expect(made.code).toBe(0);
    expect(JSON.parse(made.out).address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(made.err).toContain('never fund it');
    expect(statSync(ks2).mode & 0o777).toBe(0o600);
    const again = await run(['keygen', '--keystore', ks2, '--password-env', 'ATTESTOR_PW']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('exists');

    // the private key never appears in anything the tool printed or wrote, in any case, with or without 0x
    const printed = transcript.join('\n').toLowerCase();
    expect(printed).not.toContain(PRIV_HEX);
    for (const t of transcript.slice(-2)) expect(t).not.toMatch(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/); // keygen prints no 32-byte value at all
    for (const f of [ks, ks2, out]) expect(readFileSync(f, 'utf8').toLowerCase()).not.toContain(PRIV_HEX);
  });

  it('the scrypt override works only under the test harness, and a weak keystore is refused outside it', async () => {
    const d = tmp();
    const ks = join(d, 'k.json');
    const outside = cliIo({ HOME: d, [TEST_SCRYPT_N_ENV]: '16', ATTESTOR_PW: PW });
    expect(await main(['keygen', '--keystore', ks, '--password-env', 'ATTESTOR_PW'], outside.io)).toBe(2);
    expect(outside.err.join('\n')).toContain('only under the test harness');
    expect(existsSync(ks)).toBe(false);
    // a keystore made at test strength (here, by the harness) is not used by a production run: import re-encrypts it
    writeFileSync(ks, JSON.stringify(await createKeystore(key, PW, { scryptN: 16, env: HARNESS })));
    const prod = cliIo({ HOME: d, ATTESTOR_PW: PW });
    expect(await main(['address', '--keystore', ks, '--password-env', 'ATTESTOR_PW'], prod.io)).toBe(1);
    expect(prod.err.join('\n')).toContain('weak-kdf');
  });

  it('reads the password from the terminal by default; with no terminal it says so and what an env password exposes', async () => {
    const d = tmp();
    const ks = join(d, 'k.json');
    writeFileSync(ks, JSON.stringify(await createKeystore(key, PW, { scryptN: 16, env: HARNESS })));
    const prompts: string[] = [];
    const tty = cliIo({ ...HARNESS, HOME: d }, { password: async (p) => (prompts.push(p), PW) });
    expect(await main(['address', '--keystore', ks], tty.io)).toBe(0);
    expect(prompts).toEqual(['Keystore password: ']);
    expect(tty.all()).not.toContain(PW);
    const notty = { isTTY: false, on: () => undefined, removeListener: () => undefined, resume: () => undefined, pause: () => undefined };
    const none = cliIo({ ...HARNESS, HOME: d }, { password: (p) => readHiddenLine(notty, { write: () => true }, p) });
    expect(await main(['address', '--keystore', ks], none.io)).toBe(1);
    expect(none.err.join('\n')).toMatch(/no-tty: .*--password-env.*\/proc/);
    const usage = cliIo({ ...HARNESS, HOME: d });
    expect(await main(['sign'], usage.io)).toBe(2);
    expect(await main(['export-key'], usage.io)).toBe(2);
    expect(await main(['--help'], usage.io)).toBe(0);
    expect(usage.out.join('')).toContain('merces-attestor <command>');
  });

  it('readHiddenLine reads in raw mode, echoes nothing and restores the terminal, also on Ctrl-C', async () => {
    const fake = () => {
      const e = new EventEmitter() as EventEmitter & { isTTY: boolean; modes: boolean[]; setRawMode(m: boolean): void; resume(): void; pause(): void };
      e.isTTY = true;
      e.modes = [];
      e.setRawMode = (m) => void e.modes.push(m);
      e.resume = () => undefined;
      e.pause = () => undefined;
      return e;
    };
    const written: string[] = [];
    const input = fake();
    const p = readHiddenLine(input, { write: (s: string) => written.push(s) }, 'Password: ');
    input.emit('data', Buffer.from('secr'));
    input.emit('data', Buffer.from('eX\u007ft'));
    input.emit('data', Buffer.from('\r'));
    expect(await p).toBe('secret');
    expect(written).toEqual(['Password: ', '\n']);
    expect(input.modes).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
    const aborted = fake();
    const q = readHiddenLine(aborted, { write: () => true }, 'Password: ');
    aborted.emit('data', 'sec\u0003');
    await rejectsWith(q, 'aborted');
    expect(aborted.modes).toEqual([true, false]);
  });

  it('runs as the package\'s bin under tsx', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { bin: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.bin).toEqual({ 'merces-attestor': './src/attestor-cli.ts' });
    expect(pkg.dependencies['@noble/hashes']).toBe('2.4.0');
    const cli = fileURLToPath(new URL('../src/attestor-cli.ts', import.meta.url));
    expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env tsx\n')).toBe(true);
    const d = tmp();
    const ks = join(d, 'k.json');
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
    const env = { ...process.env, VITEST: 'true', HOME: d, [TEST_SCRYPT_N_ENV]: '16', ATTESTOR_PW: PW };
    const made = spawnSync(tsx, [cli, 'keygen', '--keystore', ks, '--password-env', 'ATTESTOR_PW'], { env, encoding: 'utf8' });
    expect(made.status).toBe(0);
    const addr = spawnSync(tsx, [cli, 'address', '--keystore', ks, '--password-env', 'ATTESTOR_PW'], { env, encoding: 'utf8' });
    expect(addr.status).toBe(0);
    expect(JSON.parse(addr.stdout).address).toBe(JSON.parse(made.stdout).address);
    expect(spawnSync(tsx, [cli, 'nonsense'], { env, encoding: 'utf8' }).status).toBe(2);
  });
});

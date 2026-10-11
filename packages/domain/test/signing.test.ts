import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EVM_CHAIN_IDS, MAGIC, SECP256K1_N, SOLANA_CLUSTER_TAGS, addressFromPrivateKey, bidCommitmentBytes, bidCommitmentPreimage, fromPid, parsePeriod,
  publicKeyFromPrivate, seriesKeyFromId, signDigest, toChecksumAddress,
} from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import {
  EVM_LOCAL_CHAIN_ID, EVM_MAINNET_CHAIN_IDS, EVM_TESTNET_CHAIN_IDS, KEY_GRACE_SECONDS, SIGNING_KINDS, SOLANA_LOCAL_TAG, SOLANA_MAINNET_TAGS,
  SOLANA_SIGNING_TAGS, SigningError, amendDigest, assertLocalSigningNetwork, assertNoMainnetAllowed, assertSigningNetwork, attestationSchema, checkSigningRequest,
  extinguishDigest, fxDigest, isLocalSigningDomain, keyGraceUntil, keyUsable, pauseDigest, personalMessageDigest, recoverSigner, reportDigest, seriesKeyOf,
  signature65Hex, signature65Schema, signedBy, signerAddressSchema, signingDigest, signingDomain, signingRequest, trueUpDigest, wallet32Of,
  type SigningDomain, type SigningFields, type SigningKind, type SigningRequest,
} from '../src/index.ts';

/*
 * S4 cause codes:
 *  - S4-G: the signing primitives are Stage 1's own (through `@merces/math`), wrapped hex-in, hex-out in signing.ts;
 *  - S4-KAT: Stage 1's known answers (`stage1/packages/vectors/known_answers.json`, "KA"), byte for byte.
 */

const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors/', import.meta.url));
interface KaMessage {
  kind: SigningKind; magic: string; domain: string; seriesKey: string; fields: Record<string, string | number | boolean>;
  preimage: string; preimageLength: number; digest: string; signer: string; signerAddress: string; signature: string; r: string; s: string; v: number;
}
const KA = JSON.parse(readFileSync(VECTORS + 'known_answers.json', 'utf8')) as {
  wallets: { kind: 'solana' | 'evm'; input: string; wallet: string }[];
  domains: { name: string; chainKind: 1 | 2; chainId: string; registry: string; preimage: string; domain: string }[];
  seriesKeys: { evm: { seriesId: string; key: string }; solana: { base58: string; key: string } };
  bidCommitments: { price: string; quantity: string; salt: string; wallet: string; preimage: string; commitment: string }[];
  testKeys: { seed: string; privateKey: string; publicKey: string; address: string; addressChecksum: string }[];
  messages: KaMessage[];
};
const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');
const keyOf = (seed: string): string => KA.testKeys.find((k) => k.seed === seed)!.privateKey;
const familyOf = (kind: 1 | 2): 'solana' | 'evm' => (kind === 1 ? 'solana' : 'evm');
const domainOf = (name: string) => KA.domains.find((d) => d.name === name)!;
/** KA's series key for a message: the EVM entries bind `bytes32(uint256(1))`, the Solana ones the series PDA. */
const seriesKeyFor = (m: KaMessage): string => (domainOf(m.domain).chainKind === 2 ? KA.seriesKeys.evm.key : KA.seriesKeys.solana.key);

/** KA's message fields in the canonical model's names ("YYYYQn" periods, decimal strings). */
function fieldsOf(m: KaMessage): SigningFields[SigningKind] {
  const f = m.fields;
  switch (m.kind) {
    case 'REPORT': return { periodId: fromPid(f.period as number), priorIncomeCommitment: f.priorIncomeCommitment as string, incomeCommitment: f.incomeCommitment as string, tier: f.tier as 2 | 3, liquidityEvent: f.liquidityEvent as boolean };
    case 'FX': return { periodId: fromPid(f.period as number), fxRateWad: f.fxRateWad as string };
    case 'AMEND': return { amendmentNonce: f.amendmentNonce as string, termsCommitment: f.newTermsCommitment as string, capMultipleWad: f.newCapMultipleWad as string };
    case 'PAUSE': return { pauseNonce: f.pauseNonce as string, pauseEnd: f.pauseEnd as string };
    case 'EXTINGUISH': return { extinguishNonce: f.extinguishNonce as string };
    case 'TRUEUP': return { trueupNonce: f.trueupNonce as string, year: f.year as number, adjustment: f.adjustment as string, attestationTs: f.attestationTs as string };
  }
}

describe('Stage 1 known answers through signing.ts (cause S4-KAT)', () => {
  it('KA has the sections S4 checks: 20 messages, 2 domains, 2 series keys, 2 bid commitments, 5 keys, 4 wallets', () => {
    expect([KA.messages.length, KA.domains.length, Object.keys(KA.seriesKeys).length, KA.bidCommitments.length, KA.testKeys.length, KA.wallets.length]).toEqual([20, 2, 2, 2, 5, 4]);
    // the period codec agrees with Stage 1's ids (2026Q3 = 8106, the KA REPORT period)
    expect(fromPid(8106)).toBe('2026Q3');
  });

  it('the 5 test keys: Stage 1\'s derivation, public key, address and EIP-55 form', () => {
    for (const k of KA.testKeys) {
      const sk = deriveTestPrivateKey(k.seed);
      expect(hex(sk), k.seed).toBe(k.privateKey);
      expect(hex(publicKeyFromPrivate(sk)), k.seed).toBe(k.publicKey);
      expect(hex(addressFromPrivateKey(sk)), k.seed).toBe(k.address);
      expect(toChecksumAddress(k.address), k.seed).toBe(k.addressChecksum);
    }
  });

  it('the 4 wallets through wallet32Of (a Solana pubkey as-is, an EVM address left-padded; any EVM case)', () => {
    for (const w of KA.wallets) expect(hex(wallet32Of(w.input, w.kind)), w.input).toBe(w.wallet);
  });

  it('the 2 domains through signingDomain (from the 32-byte registry, and from its chain-local address)', () => {
    for (const d of KA.domains) {
      const ours = signingDomain(familyOf(d.chainKind), d.chainId, d.registry);
      expect(ours).toEqual({ chainKind: d.chainKind, chainId: d.chainId, registry: d.registry, domain: d.domain });
    }
    // the Solana registry given in base58 (KA registryNote), the EVM one as its 20-byte address
    expect(signingDomain('solana', 103n, 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR').domain).toBe(domainOf('solana-devnet').domain);
    expect(signingDomain('evm', 10143, '0x' + '11'.repeat(20)).domain).toBe(domainOf('evm-monad-testnet').domain);
  });

  it('the 2 series keys through seriesKeyOf; the monad pseudo-address key is seriesKeyFromId(BigInt(addr))', () => {
    expect(seriesKeyOf(`monad:${KA.seriesKeys.evm.seriesId}`, 'evm')).toBe(KA.seriesKeys.evm.key);
    expect(seriesKeyOf(`solana:${KA.seriesKeys.solana.base58}`, 'solana')).toBe(KA.seriesKeys.solana.key);
    const addr = '0x' + 'ab'.repeat(20);
    expect(seriesKeyOf(`monad:${addr}`, 'evm')).toBe(hex(seriesKeyFromId(BigInt(addr))));
    expect(seriesKeyOf(`monad:${addr}`, 'evm')).toBe('0x' + '00'.repeat(12) + 'ab'.repeat(20));
    expect(() => seriesKeyOf('monad:zz', 'evm')).toThrow(RangeError);
    expect(() => seriesKeyOf('monad:0x' + '11'.repeat(20), 'solana')).toThrow(RangeError);
    expect(() => seriesKeyOf('not a series', 'evm')).toThrow(RangeError);
  });

  it('the 2 bid commitments through bidCommitmentBytes (Stage 1\'s keccak; our hex bidCommitment and orderCommitment: domain.test.ts, cause S4-BID)', () => {
    for (const b of KA.bidCommitments) {
      const wallet = Uint8Array.from(Buffer.from(b.wallet.slice(2), 'hex'));
      expect(hex(bidCommitmentPreimage(BigInt(b.price), BigInt(b.quantity), b.salt, wallet))).toBe(b.preimage);
      expect(hex(bidCommitmentBytes(BigInt(b.price), BigInt(b.quantity), b.salt, wallet))).toBe(b.commitment);
    }
  });

  it('the 20 messages: pre-image, digest, signature byte-equal to signDigest(testKeys[signer]), recovery to the signer', () => {
    const kinds = new Set<string>();
    for (const [i, m] of KA.messages.entries()) {
      kinds.add(m.kind);
      const at = `message ${i} ${m.kind} (${m.domain})`;
      expect(m.magic, at).toBe(MAGIC[m.kind]);
      const built = signingDigest(m.kind, { domain: domainOf(m.domain).domain, seriesKey: seriesKeyFor(m) }, fieldsOf(m));
      expect(built, at).toEqual({ kind: m.kind, preimage: m.preimage, digest: m.digest });
      expect((built.preimage.length - 2) / 2, at).toBe(m.preimageLength);
      const sig = signDigest(built.digest, keyOf(m.signer));
      expect(signature65Hex(sig), at).toBe(m.signature);
      expect([hex(Uint8Array.from(Buffer.from(sig.r.toString(16).padStart(64, '0'), 'hex'))), sig.v], at).toEqual([m.r, m.v]);
      expect(recoverSigner(built.digest, m.signature), at).toBe(m.signerAddress);
      expect(signedBy(built.digest, m.signature, m.signerAddress), at).toBe(true);
      expect(signedBy(built.digest, m.signature, toChecksumAddress(m.signerAddress)), at).toBe(true);
    }
    expect([...kinds].sort()).toEqual([...SIGNING_KINDS].sort());
    // both recovery ids occur
    expect(new Set(KA.messages.map((m) => m.v))).toEqual(new Set([27, 28]));
  });

  it('the named wrappers are the dispatch (reportDigest … trueUpDigest), with the canonical model\'s field names', () => {
    const ctx = { domain: domainOf('evm-monad-testnet').domain, seriesKey: KA.seriesKeys.evm.key };
    const by = (kind: SigningKind) => KA.messages.find((m) => m.kind === kind && m.domain === 'evm-monad-testnet')!;
    expect(reportDigest(ctx, fieldsOf(by('REPORT')) as SigningFields['REPORT']).digest).toBe(by('REPORT').digest);
    expect(fxDigest(ctx, fieldsOf(by('FX')) as SigningFields['FX']).digest).toBe(by('FX').digest);
    expect(amendDigest(ctx, fieldsOf(by('AMEND')) as SigningFields['AMEND']).digest).toBe(by('AMEND').digest);
    expect(pauseDigest(ctx, fieldsOf(by('PAUSE')) as SigningFields['PAUSE']).digest).toBe(by('PAUSE').digest);
    expect(extinguishDigest(ctx, fieldsOf(by('EXTINGUISH')) as SigningFields['EXTINGUISH']).digest).toBe(by('EXTINGUISH').digest);
    // the first TRUEUP has a negative adjustment (two's complement i64)
    const tu = by('TRUEUP');
    expect(tu.fields.adjustment).toBe('-2500000000');
    expect(trueUpDigest(ctx, { ...(fieldsOf(tu) as SigningFields['TRUEUP']), adjustment: -2_500_000_000n }).digest).toBe(tu.digest);
    // numbers as bigints give the same bytes as decimal strings
    expect(pauseDigest(ctx, { pauseNonce: 0n, pauseEnd: 1_783_209_600n }).digest).toBe(by('PAUSE').digest);
  });
});

describe('recovery refuses every non-canonical signature (cause S4-G; S4 D8)', () => {
  const m = KA.messages[0]!;
  const sigBytes = (): Uint8Array => Uint8Array.from(Buffer.from(m.signature.slice(2), 'hex'));
  const be32 = (x: bigint): string => x.toString(16).padStart(64, '0');

  it('high s with v flipped (the malleable twin) recovers to nobody', () => {
    const b = sigBytes();
    const s = BigInt('0x' + Buffer.from(b.slice(32, 64)).toString('hex'));
    const twin = '0x' + Buffer.from(b.slice(0, 32)).toString('hex') + be32(SECP256K1_N - s) + (b[64] === 27 ? '1c' : '1b');
    expect(signature65Schema.safeParse(twin).success).toBe(true); // the schema is shape only
    expect(recoverSigner(m.digest, twin)).toBeNull();
    expect(signedBy(m.digest, twin, m.signerAddress)).toBe(false);
  });
  it('v ∈ {0, 1}, 64 bytes, r = 0, s = 0, r ≥ n and non-hex recover to nobody', () => {
    const b = sigBytes();
    const body = Buffer.from(b.slice(0, 64)).toString('hex');
    for (const v of ['00', '01', '1d']) expect(recoverSigner(m.digest, '0x' + body + v), v).toBeNull();
    expect(recoverSigner(m.digest, '0x' + body)).toBeNull();
    expect(recoverSigner(m.digest, '0x' + '00'.repeat(32) + body.slice(64) + '1b')).toBeNull();
    expect(recoverSigner(m.digest, '0x' + body.slice(0, 64) + '00'.repeat(32) + '1b')).toBeNull();
    expect(recoverSigner(m.digest, '0x' + be32(SECP256K1_N) + body.slice(64) + '1b')).toBeNull();
    expect(recoverSigner(m.digest, '0x' + 'zz'.repeat(65))).toBeNull();
    expect(recoverSigner(m.digest, m.signature.slice(0, -1))).toBeNull(); // odd length: never padded into 65 bytes
  });
  it('a signature over another digest recovers to someone else; a malformed digest is a caller error', () => {
    const other = KA.messages[1]!;
    expect(recoverSigner(other.digest, m.signature)).not.toBe(m.signerAddress);
    expect(() => recoverSigner('0x1234', m.signature)).toThrow(RangeError);
    expect(signedBy(m.digest, m.signature, 'not-an-address')).toBe(false);
  });
  it('schemas: the signer is lowercase 0x + 40 hex; an attestation is exactly {signer, signature}', () => {
    expect(signerAddressSchema.safeParse(m.signerAddress).success).toBe(true);
    expect(signerAddressSchema.safeParse(toChecksumAddress(m.signerAddress)).success).toBe(false);
    expect(signature65Schema.safeParse(m.signature.toUpperCase().replace('0X', '0x')).success).toBe(false);
    expect(attestationSchema.safeParse({ signer: m.signerAddress, signature: m.signature }).success).toBe(true);
    expect(attestationSchema.safeParse({ signer: m.signerAddress, signature: m.signature, keyId: 'x' }).success).toBe(false);
  });
});

describe('message inputs are checked, value-free (cause S4-G)', () => {
  const ctx = { domain: domainOf('evm-monad-testnet').domain, seriesKey: KA.seriesKeys.evm.key };
  it('refuses a tier other than 2 or 3, out-of-range integers and short keys without echoing the value', () => {
    const c = '0x' + '11'.repeat(32);
    expect(() => reportDigest(ctx, { periodId: '2026Q3', priorIncomeCommitment: c, incomeCommitment: c, tier: 1 as 2, liquidityEvent: false })).toThrow(/tier 2 \(verifier\) or tier 3/);
    expect(() => pauseDigest(ctx, { pauseNonce: 0n, pauseEnd: 1n << 64n })).toThrow(/^pauseEnd is out of the u64 range$/);
    expect(() => pauseDigest(ctx, { pauseNonce: '-1', pauseEnd: 1n })).toThrow(/^pauseNonce is not an unsigned integer$/);
    expect(() => trueUpDigest(ctx, { trueupNonce: 0, year: 2026, adjustment: (1n << 63n).toString(), attestationTs: 1 })).toThrow(/^adjustment is out of the i64 range$/);
    expect(() => trueUpDigest(ctx, { trueupNonce: 0, year: 70_000, adjustment: 0n, attestationTs: 1 })).toThrow(/u16/);
    expect(() => extinguishDigest({ ...ctx, seriesKey: '0x01' }, { extinguishNonce: 0 })).toThrow(/^seriesKey must be 32-byte 0x-hex$/);
    expect(() => fxDigest(ctx, { periodId: '2026Q5', fxRateWad: 1n })).toThrow(RangeError);
  });
});

describe('revocation grace (cause S4-G; Stage 1 SPEC §1.4, forward-only)', () => {
  const period = '2026Q3';
  const end = parsePeriod(period).end;
  it('KEY_GRACE_SECONDS is (report_due_days + grace_days) × DAY = 3,888,000 s', () => {
    expect(KEY_GRACE_SECONDS).toBe(3_888_000);
    expect(keyGraceUntil(end)).toBe(end + 3_888_000);
    expect(keyGraceUntil(null)).toBeNull();
  });
  it('a period ending at the revocation: usable through revokedAt + grace, not one second later', () => {
    const k = { active: false, revokedAt: end };
    expect(keyUsable(k, end + KEY_GRACE_SECONDS, { reportPeriod: period })).toBe(true);
    expect(keyUsable(k, end + KEY_GRACE_SECONDS + 1, { reportPeriod: period })).toBe(false);
  });
  it('a period ending one second after the revocation is refused at once', () => {
    expect(keyUsable({ active: false, revokedAt: end - 1 }, end, { reportPeriod: period })).toBe(false);
  });
  it('an active key is always usable; without a report period (AMEND, PAUSE, EXTINGUISH, TRUEUP) only an active one', () => {
    expect(keyUsable({ active: true, revokedAt: null }, 4_000_000_000)).toBe(true);
    expect(keyUsable({ active: true, revokedAt: null }, 4_000_000_000, { reportPeriod: period })).toBe(true);
    expect(keyUsable({ active: false, revokedAt: end }, end)).toBe(false);
    expect(keyUsable({ active: false, revokedAt: null }, end, { reportPeriod: period })).toBe(false);
    expect(keyUsable({ active: false, revokedAt: 0 }, 0, { reportPeriod: '1970Q1' })).toBe(false);
  });
});

describe('the network allow-list and the mainnet tripwire (cause S4-G; S4 D6)', () => {
  const sol = (tag: bigint): SigningDomain => signingDomain('solana', tag, '0x' + '22'.repeat(32));
  const evm = (id: number): SigningDomain => signingDomain('evm', id, '0x' + '33'.repeat(20));
  const code = (f: () => void): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return e instanceof SigningError ? e.code : `not a SigningError: ${(e as Error).message}`;
    }
  };
  it('is seeded from Stage 1\'s constants', () => {
    expect(EVM_TESTNET_CHAIN_IDS.get(Number(EVM_CHAIN_IDS.monadTestnet))).toBe('Monad Testnet');
    expect(EVM_MAINNET_CHAIN_IDS.has(Number(EVM_CHAIN_IDS.monadMainnet))).toBe(true);
    expect([...SOLANA_MAINNET_TAGS]).toEqual([SOLANA_CLUSTER_TAGS.mainnetBeta]);
    expect([...SOLANA_SIGNING_TAGS.keys()].sort()).toEqual([SOLANA_CLUSTER_TAGS.testnet, SOLANA_CLUSTER_TAGS.devnet].sort());
    expect(SOLANA_LOCAL_TAG).toBe(SOLANA_CLUSTER_TAGS.localnet);
    expect(EVM_LOCAL_CHAIN_ID).toBe(31337);
  });
  it('signs for testnets and devnet; local ids only with allowLocal', () => {
    for (const d of [sol(102n), sol(103n), evm(10143), evm(11155111)]) expect(code(() => assertSigningNetwork(d))).toBeNull();
    expect(code(() => assertSigningNetwork(sol(104n)))).toBe('network-not-allowed');
    expect(code(() => assertSigningNetwork(evm(31337)))).toBe('network-not-allowed');
    expect(code(() => assertSigningNetwork(sol(104n), { allowLocal: true }))).toBeNull();
    expect(code(() => assertSigningNetwork(evm(31337), { allowLocal: true }))).toBeNull();
    expect(code(() => assertSigningNetwork(evm(999)))).toBe('network-not-allowed');
  });
  it('a published dev or test key signs for the local ids only: a testnet is live (S4 WP6 fix 1, A-REV-9)', () => {
    expect([sol(104n), evm(31337)].map(isLocalSigningDomain)).toEqual([true, true]);
    expect([sol(102n), sol(103n), sol(101n), evm(10143), evm(143), evm(104), { chainKind: 1 as const, chainId: '31337' }].map(isLocalSigningDomain)).toEqual([false, false, false, false, false, false, false]);
    for (const d of [sol(104n), evm(31337)]) expect(code(() => assertLocalSigningNetwork(d))).toBeNull();
    for (const d of [sol(102n), sol(103n), evm(10143), evm(11155111)]) expect(code(() => assertLocalSigningNetwork(d))).toBe('network-not-allowed');
    expect(() => assertLocalSigningNetwork(sol(103n))).toThrow(/simulator only/);
    // a mainnet by name, and a forged domain, as assertSigningNetwork
    for (const d of [sol(101n), evm(143)]) expect(code(() => assertLocalSigningNetwork(d))).toBe('mainnet');
    expect(code(() => assertLocalSigningNetwork({ ...evm(31337), domain: sol(104n).domain }))).toBe('domain-mismatch');
  });
  it('refuses every mainnet by name, allowLocal or not', () => {
    for (const d of [sol(101n), evm(143), evm(1), evm(8453)]) {
      expect(code(() => assertSigningNetwork(d))).toBe('mainnet');
      expect(code(() => assertSigningNetwork(d, { allowLocal: true }))).toBe('mainnet');
    }
    expect(() => assertSigningNetwork(evm(143))).toThrow(/never mainnet/);
  });
  it('refuses a domain hash that is not its fields\' and a malformed domain', () => {
    const d = evm(10143);
    expect(code(() => assertSigningNetwork({ ...d, domain: sol(103n).domain }))).toBe('domain-mismatch');
    expect(code(() => assertSigningNetwork({ ...d, chainId: '010143' }))).toBe('malformed');
    expect(code(() => assertSigningNetwork({ ...d, chainKind: 3 as 1 }))).toBe('malformed');
  });
  it('the tripwire throws when an allow-list holds a mainnet id', () => {
    expect(() => assertNoMainnetAllowed('evm', [10143, 143], EVM_MAINNET_CHAIN_IDS)).toThrow(/mainnet id 143/);
    expect(() => assertNoMainnetAllowed('solana', [103n, 101n], SOLANA_MAINNET_TAGS)).toThrow(/mainnet id 101/);
    expect(() => assertNoMainnetAllowed('evm', [...EVM_TESTNET_CHAIN_IDS.keys(), EVM_LOCAL_CHAIN_ID], EVM_MAINNET_CHAIN_IDS)).not.toThrow();
  });
});

describe('signing requests: the device rebuilds everything and trusts nothing (cause S4-G; S4 D2)', () => {
  const devnet = signingDomain('solana', 103n, 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR');
  const seriesId = `solana:${KA.seriesKeys.solana.base58}`;
  const signer = KA.testKeys.find((k) => k.seed === 'attestor1')!.address;
  const pinned = { solana: devnet };
  const pause = (): SigningRequest<'PAUSE'> => signingRequest({ kind: 'PAUSE', chain: 'solana', seriesId, seriesKey: KA.seriesKeys.solana.key, domain: devnet, signer, fields: { pauseNonce: '0', pauseEnd: '1783209600' } });
  const code = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return e instanceof SigningError ? e.code : `not a SigningError: ${(e as Error).message}`;
    }
  };

  it('a request the API builds passes the device check, which returns the digest it rebuilt (KA PAUSE on solana-devnet)', () => {
    const req = pause();
    const ka = KA.messages.find((m) => m.kind === 'PAUSE' && m.domain === 'solana-devnet')!;
    expect(req.digest).toBe(ka.digest);
    expect(req.validWhile).toBe('pause nonce 0');
    expect(checkSigningRequest(JSON.parse(JSON.stringify(req)), pinned)).toEqual({ kind: 'PAUSE', preimage: ka.preimage, digest: ka.digest, signer });
    expect(Object.keys(req).sort()).toEqual(['chain', 'digest', 'domain', 'fields', 'kind', 'preimage', 'seriesId', 'seriesKey', 'signer', 'validWhile']);
  });
  it('refuses a digest or pre-image mismatch, an edited field, an edited validWhile and extra or unknown content', () => {
    const req = pause();
    expect(code(() => checkSigningRequest({ ...req, digest: KA.messages[0]!.digest }, pinned))).toBe('digest-mismatch');
    expect(code(() => checkSigningRequest({ ...req, preimage: req.preimage.slice(0, -2) + 'ff' }, pinned))).toBe('digest-mismatch');
    expect(code(() => checkSigningRequest({ ...req, fields: { ...req.fields, pauseEnd: '1783209601' } }, pinned))).toBe('digest-mismatch');
    expect(code(() => checkSigningRequest({ ...req, validWhile: 'forever' }, pinned))).toBe('malformed');
    expect(code(() => checkSigningRequest({ ...req, display: ['approve'] }, pinned))).toBe('malformed');
    expect(code(() => checkSigningRequest({ ...req, kind: 'TRANSFER' }, pinned))).toBe('malformed');
    expect(code(() => checkSigningRequest({ ...req, fields: { ...req.fields, extra: 1 } }, pinned))).toBe('malformed');
    expect(code(() => checkSigningRequest({ ...req, fields: { pauseNonce: '0', pauseEnd: (1n << 64n).toString() } }, pinned))).toBe('malformed');
  });
  it('refuses an unpinned chain, a domain other than the pinned one, and a series key that is not the series id\'s', () => {
    const req = pause();
    expect(code(() => checkSigningRequest(req, {}))).toBe('unpinned-chain');
    expect(code(() => checkSigningRequest(req, { solana: signingDomain('solana', 102n, devnet.registry) }))).toBe('domain-mismatch');
    const other = signingDomain('solana', 103n, '0x' + '44'.repeat(32));
    expect(code(() => checkSigningRequest({ ...req, domain: other }, pinned))).toBe('domain-mismatch');
    expect(code(() => checkSigningRequest({ ...req, seriesKey: '0x' + '55'.repeat(32) }, pinned))).toBe('series-mismatch');
    expect(code(() => checkSigningRequest({ ...req, seriesId: 'monad:' + KA.seriesKeys.solana.base58 }, pinned))).toBe('series-mismatch');
  });
  it('refuses Solana tag 101 and EVM chain id 143 even when pinned; a local id needs allowLocal', () => {
    const req = pause();
    const mainnet = signingDomain('solana', 101n, devnet.registry);
    expect(code(() => checkSigningRequest({ ...req, domain: mainnet }, { solana: mainnet }))).toBe('mainnet');
    const monadMain = signingDomain('evm', 143, '0x' + '11'.repeat(20));
    const evmReq = { ...req, chain: 'monad', seriesId: 'monad:1', seriesKey: KA.seriesKeys.evm.key, domain: monadMain };
    expect(code(() => checkSigningRequest(evmReq, { monad: monadMain }))).toBe('mainnet');
    expect(code(() => signingRequest({ ...pause(), domain: mainnet }))).toBe('mainnet');
    const local = signingDomain('solana', 104n, devnet.registry);
    const localReq = signingRequest({ kind: 'EXTINGUISH', chain: 'solana', seriesId, seriesKey: KA.seriesKeys.solana.key, domain: local, signer, fields: { extinguishNonce: '0' } });
    expect(code(() => checkSigningRequest(localReq, { solana: local }))).toBe('network-not-allowed');
    expect(checkSigningRequest(localReq, { solana: local }, { allowLocal: true }).digest).toBe(localReq.digest);
  });
  it('the API side refuses a series off its chain or with another series key, and malformed fields', () => {
    expect(code(() => signingRequest({ ...pause(), chain: 'monad' }))).toBe('series-mismatch');
    expect(code(() => signingRequest({ ...pause(), seriesKey: '0x' + '00'.repeat(32) }))).toBe('series-mismatch');
    expect(code(() => signingRequest({ ...pause(), signer: toChecksumAddress(signer) }))).toBe('malformed');
    expect(code(() => signingRequest({ ...pause(), fields: { pauseNonce: '00', pauseEnd: '1' } }))).toBe('malformed');
  });
});

describe('link proofs (EIP-191) are never attestations (cause S4-G; S4 D4)', () => {
  it('personalMessageDigest is keccak256("\\x19Ethereum Signed Message:\\n" ‖ len ‖ message); viem agreement is pinned in packages/ports/test', () => {
    // the well-known EIP-191 digest of "hello world" (byte length 11)
    expect(personalMessageDigest('hello world')).toBe('0xd9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68');
    expect(personalMessageDigest(new TextEncoder().encode('hello world'))).toBe(personalMessageDigest('hello world'));
    // the length is in bytes, not characters
    expect(personalMessageDigest('é')).not.toBe(personalMessageDigest('e'));
  });
  it('a key signs a link proof and the proof recovers to it; it is never a MERCES_* digest', () => {
    const sk = deriveTestPrivateKey('attestor1');
    const d = personalMessageDigest('Link this key to Merces account acc_1 (nonce 42)');
    expect(recoverSigner(d, signature65Hex(signDigest(d, sk)))).toBe(hex(addressFromPrivateKey(sk)));
    expect(KA.messages.every((m) => m.digest !== d && m.preimage.startsWith('0x4d4552434553'))).toBe(true);
  });
});

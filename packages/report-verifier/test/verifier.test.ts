import { describe, expect, it } from 'vitest';
import { ZERO_INCOME_COMMITMENT, incomeCommitment, recoverSigner, reportDigest, seriesKeyOf, signingDomain, type ReportAttestationRecord } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { LocalKms, MockZkTls } from '@merces/ports';
import {
  DEV_KEY_SEED, HttpReportVerifierClient, ReportVerifier, VerifierConfigError, createVerifierServer, previousAddressesFromEnv, verifierChainsFromEnv, verifierSetupFromEnv, type AttestRequest,
  type VerifierChain,
} from '../src/index.ts';

/*
 * S4 cause codes:
 *  - S4-KMS: a local KMS key id names its algorithm explicitly (S4 WP3).
 *  - S4-T2: the verifier signs Stage 1's REPORT message (`MERCES_REPORT_V1`, tier 2) with a secp256k1 key over the
 *    domain of the series' chain from its own table and the series key (S4 WP6, D10; was ed25519 over attestation v1
 *    named by a key id); its result is a `ReportAttestationRecord`; it starts only with an allow-listed table (never
 *    mainnet) and the KMS key's address equal to its pin; a prior is its own record over the same domain, by its current
 *    address or a previous one retired at or after the prior quarter's end (amendment D10). Development
 *    (`MERCES_VERIFIER_DEV=true`: the published dev seed, no pin) is the simulator only: a table with any live chain, a
 *    testnet included, refuses the start (S4 WP6 fix 1, A-REV-9).
 */

/** Stage 1's known-answer domains (known_answers.json `domains`): Solana devnet (tag 103) and Monad testnet (10143). */
const SOLANA_DEVNET = signingDomain('solana', 103, 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR');
const MONAD_TESTNET = signingDomain('evm', 10143, '0x1111111111111111111111111111111111111111');
const CHAINS: VerifierChain[] = [{ chain: 'solana', domain: SOLANA_DEVNET }, { chain: 'monad', domain: MONAD_TESTNET }];
/** Stage 1's known-answer Solana series PDA (known_answers.json `seriesKeys.solana`). */
const SERIES_ADDRESS = 'GoZWJaEDVa6RTuyo3xqX5NFuwhRiSSdS8chwZtDeCPZe';

describe('report verifier (Stage 1 REPORT signature: prior, liquidity event, high-water)', () => {
  const zktls = new MockZkTls();
  const kms = new LocalKms('verifier-test', { 'rv-1': 'secp256k1' }); // cause S4-KMS, S4-T2: explicit algorithm, secp256k1
  const verifier = new ReportVerifier(zktls, kms, { keyId: 'rv-1', chains: CHAINS });
  const seriesId = `solana:${SERIES_ADDRESS}`;
  const seriesKey = seriesKeyOf(seriesId, 'solana');
  const figure = 7_317_317_317n; // canary value
  const salt = '5761287346129834761298347612983476129834761298347612983476129834'; // a field element (decimal)
  const salt2 = '4242424242424242424242424242424242424242424242424242424242424242';
  const proofFor = (periodId: string, f: bigint, currency = 'USD', source: 'stripe' | 'deel' | 'distrokid' = 'stripe', series = seriesId) => zktls.prove({ source, seriesId: series, periodId, figure: f, currency, coversUntil: 1_000, owner: 'issuer' });
  const req = (over: Partial<AttestRequest> & Pick<AttestRequest, 'periodId' | 'zktlsProof' | 'incomeCommitment'>): AttestRequest => ({
    seriesId, tier: 2, source: 'stripe', reportingCurrency: 'USD', incomeSalt: salt, priorIncomeCommitment: ZERO_INCOME_COMMITMENT, ...over,
  });
  /** a Q1 attestation, the prior of Q2 */
  async function q1(v: ReportVerifier = verifier, f = figure): Promise<{ attestation: ReportAttestationRecord; commitment: string }> {
    const commitment = incomeCommitment(f, salt);
    const r = await v.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', f), incomeCommitment: commitment }));
    if (!r.ok) throw new Error(r.code);
    return { attestation: r.attestation, commitment };
  }

  it('attests a Q1 report with the ZERO prior: Stage 1\'s REPORT digest over the chain\'s domain and the series key, signed by its key; the figure is never echoed (S4-T2)', async () => {
    const ic = incomeCommitment(figure, salt);
    const r = await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: ic, liquidityEvent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r)).not.toContain(figure.toString());
    const address = await kms.signerAddress('rv-1');
    const digest = reportDigest({ domain: SOLANA_DEVNET.domain, seriesKey }, { periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: ic, tier: 2, liquidityEvent: true }).digest;
    expect(r.attestation).toEqual({ signer: address, signature: r.attestation.signature, digest, chain: 'solana', seriesId, periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: ic, tier: 2, liquidityEvent: true });
    expect(recoverSigner(digest, r.attestation.signature)).toBe(address);
    expect(r.attestation.signature).toMatch(/^0x[0-9a-f]{130}$/);
    // its published key: the address, the public key and the chain table with each domain
    const key = await verifier.publicKey();
    expect(key).toEqual({ address, publicKeyHex: (await kms.publicKey('rv-1')).publicKeyHex, chains: CHAINS, previous: [] });
  });

  it('refuses mismatched commitments, replayed contexts, tampered proofs, foreign currencies, non-field salts and series it has no chain for, with codes only', async () => {
    const ic = incomeCommitment(figure, salt);
    const proof = proofFor('2026Q1', figure);
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, incomeSalt: '42', incomeCommitment: ic }))).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeCommitment: ic }))).toEqual({ ok: false, code: 'wrong-context' });
    const tampered = { ...proof, extractedParameterValues: { ...proof.extractedParameterValues, grossIncome: '1' } };
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: tampered, incomeCommitment: ic }))).toEqual({ ok: false, code: 'bad-proof' });
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure, 'EUR'), reportingCurrency: 'GBP', incomeCommitment: ic }))).toEqual({ ok: false, code: 'currency-mismatch' });
    // a USD figure for a EUR series is refused too: θ and the payment are in the reporting currency (A-REP-4)
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, reportingCurrency: 'EUR', incomeCommitment: ic }))).toEqual({ ok: false, code: 'currency-mismatch' });
    const hashed = zktls.prove({ source: 'distrokid', seriesId, periodId: '2026Q1', figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer', hashOnly: true });
    expect(await verifier.attest(req({ periodId: '2026Q1', source: 'distrokid', zktlsProof: hashed, incomeCommitment: ic }))).toEqual({ ok: false, code: 'hash-only-unsupported' });
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, incomeSalt: '9'.repeat(78) /* ≥ the BN254 field modulus */, incomeCommitment: ic }))).toEqual({ ok: false, code: 'not-field' });
    // a year-to-date figure of 2^64 or more cannot be committed
    const huge = 1n << 64n;
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', huge), incomeCommitment: ic }))).toEqual({ ok: false, code: 'not-field' });
    // cause S4-T2: a series on a chain the verifier has no domain for, or whose id has no series key there
    for (const other of ['base:0x' + '22'.repeat(20), 'solana:not0base58', 'monad:xyz', 'solana']) {
      expect(await verifier.attest(req({ seriesId: other, periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure, 'USD', 'stripe', other), incomeCommitment: ic }))).toEqual({ ok: false, code: 'wrong-context' });
    }
  });

  it('prior rule: a chained prior needs its opening and this verifier\'s own record of the previous quarter, over the same chain\'s domain', async () => {
    const { attestation: a1, commitment: c1 } = await q1();
    const q2Figure = figure + 1_000_000_000n;
    const c2 = incomeCommitment(q2Figure, salt2);
    const opening = { incomeYtd: figure.toString(), incomeSalt: salt };
    const base = { periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2, priorIncomeCommitment: c1 };
    const ok = await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: a1 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.attestation).toMatchObject({ periodId: '2026Q2', priorIncomeCommitment: c1, incomeCommitment: c2 });
    // no opening, a wrong opening, no attestation, a forged or foreign attestation
    expect(await verifier.attest(req(base))).toEqual({ ok: false, code: 'prior-mismatch' });
    expect(await verifier.attest(req({ ...base, priorOpening: { ...opening, incomeYtd: '1' }, priorAttestation: a1 }))).toEqual({ ok: false, code: 'prior-mismatch' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, signature: '0x' + '00'.repeat(65) } }))).toEqual({ ok: false, code: 'prior-unattested' });
    const other = await q1(new ReportVerifier(zktls, new LocalKms('another-verifier', { 'rv-1': 'secp256k1' }), { keyId: 'rv-1', chains: CHAINS }));
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: other.attestation }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, periodId: '2026Q3' } }))).toEqual({ ok: false, code: 'prior-unattested' });
    // cause S4-T2: the record's own fields must agree with its signature: another signer named, another digest, another chain
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, signer: other.attestation.signer } }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, digest: '0x' + '11'.repeat(32) } }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, chain: 'monad' } }))).toEqual({ ok: false, code: 'prior-unattested' });
    // cause S4-T2: the same key's signature over another chain's domain (Monad testnet) is no prior here
    const foreignDigest = reportDigest({ domain: MONAD_TESTNET.domain, seriesKey }, a1).digest;
    const foreign = { ...a1, digest: foreignDigest, signature: await kms.signDigest('rv-1', foreignDigest) };
    expect(recoverSigner(foreignDigest, foreign.signature)).toBe(a1.signer);
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: foreign }))).toEqual({ ok: false, code: 'prior-unattested' });
    // a non-ZERO prior in Q1 is refused: a reporting year starts from ZERO
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: c1, priorIncomeCommitment: c1, priorOpening: opening, priorAttestation: a1 }))).toEqual({ ok: false, code: 'prior-mismatch' });
    // ZERO is always allowed (the issuer's least favourable prior), but only with an empty opening
    expect((await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2 }))).ok).toBe(true);
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2, priorOpening: opening }))).toEqual({ ok: false, code: 'prior-mismatch' });
  });

  it('high-water: below the prior, the committed year-to-date figure is the prior\'s (SPEC §1.5)', async () => {
    const { attestation: a1, commitment: c1 } = await q1();
    const lower = figure - 1_000_000n; // a refund lowered the real year-to-date figure
    const priorOpening = { incomeYtd: figure.toString(), incomeSalt: salt };
    const proof = proofFor('2026Q2', lower);
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeSalt: salt2, incomeCommitment: incomeCommitment(lower, salt2), priorIncomeCommitment: c1, priorOpening, priorAttestation: a1 }))).toEqual({ ok: false, code: 'commitment-mismatch' });
    const r = await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeSalt: salt2, incomeCommitment: incomeCommitment(figure, salt2), priorIncomeCommitment: c1, priorOpening, priorAttestation: a1 }));
    expect(r.ok).toBe(true);
  });

  it('rotation: a prior by a previous address is accepted only for a quarter that ended at or before its retirement (S4-T2, amendment D10)', async () => {
    const oldKms = new LocalKms('verifier-old', { 'rv-old': 'secp256k1' });
    const oldVerifier = new ReportVerifier(zktls, oldKms, { keyId: 'rv-old', chains: CHAINS });
    const oldAddress = await oldKms.signerAddress('rv-old');
    const { attestation: a1, commitment: c1 } = await q1(oldVerifier);
    expect(a1.signer).toBe(oldAddress);
    const q2Figure = figure + 1n;
    const c2 = incomeCommitment(q2Figure, salt2);
    const q2 = req({ periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2, priorIncomeCommitment: c1, priorOpening: { incomeYtd: figure.toString(), incomeSalt: salt }, priorAttestation: a1 });
    const q1End = parsePeriod('2026Q1').end;
    const withPrevious = (previous: { address: string; retiredAt: number }[]) => new ReportVerifier(zktls, kms, { keyId: 'rv-1', chains: CHAINS, previous });
    // not listed (e.g. a compromised key, removed): its priors are unattested
    expect(await withPrevious([]).attest(q2)).toEqual({ ok: false, code: 'prior-unattested' });
    // retired exactly when Q1 ended: accepted; retired one second earlier: Q1 ended after its retirement
    expect((await withPrevious([{ address: oldAddress, retiredAt: q1End }]).attest(q2)).ok).toBe(true);
    expect((await withPrevious([{ address: oldAddress.toUpperCase().replace('0X', '0x'), retiredAt: q1End + 86_400 }]).attest(q2)).ok).toBe(true);
    expect(await withPrevious([{ address: oldAddress, retiredAt: q1End - 1 }]).attest(q2)).toEqual({ ok: false, code: 'prior-unattested' });
    // the new verifier signs with its own key
    const r = await withPrevious([{ address: oldAddress, retiredAt: q1End }]).attest(q2);
    if (r.ok) expect(r.attestation.signer).toBe(await kms.signerAddress('rv-1'));
    expect((await withPrevious([{ address: oldAddress, retiredAt: q1End }]).publicKey()).previous).toEqual([{ address: oldAddress, retiredAt: q1End }]);
  });

  it('startup: never a mainnet, never an off-list network (local ids only in development), and the KMS key must be the pinned address (S4-T2)', async () => {
    const address = await kms.signerAddress('rv-1');
    const start = (over: Partial<ConstructorParameters<typeof ReportVerifier>[2]>) => ReportVerifier.create(zktls, kms, { keyId: 'rv-1', chains: CHAINS, ...over });
    // a mainnet in the table refuses the start, by name: Solana mainnet-beta (101), Monad mainnet (143), Ethereum (1)
    for (const d of [signingDomain('solana', 101, SERIES_ADDRESS), signingDomain('evm', 143, '0x' + '11'.repeat(20)), signingDomain('evm', 1, '0x' + '11'.repeat(20))]) {
      await expect(start({ chains: [...CHAINS, { chain: 'main', domain: d }] })).rejects.toThrow(/mainnet/);
    }
    // a network off the allow-list, and the local ids without allowLocal
    await expect(start({ chains: [{ chain: 'x', domain: signingDomain('evm', 999_999, '0x' + '11'.repeat(20)) }] })).rejects.toThrow(/not on the signing allow-list/);
    const local = [{ chain: 'solana', domain: signingDomain('solana', 104, SERIES_ADDRESS) }, { chain: 'monad', domain: signingDomain('evm', 31337, '0x' + '22'.repeat(20)) }];
    await expect(start({ chains: local })).rejects.toThrow(VerifierConfigError);
    await expect(start({ chains: local, allowLocal: true })).resolves.toBeInstanceOf(ReportVerifier);
    // a forged domain (its hash is not of its own fields), a chain twice
    await expect(start({ chains: [{ chain: 'solana', domain: { ...SOLANA_DEVNET, domain: MONAD_TESTNET.domain } }] })).rejects.toThrow(/keccak256/);
    await expect(start({ chains: [...CHAINS, CHAINS[0]!] })).rejects.toThrow(/twice/);
    // the address pin: equal (any case) starts; another address refuses; the current address may not also be "previous"
    await expect(start({ address: address.toUpperCase().replace('0X', '0x') })).resolves.toBeInstanceOf(ReportVerifier);
    await expect(start({ address: '0x' + '33'.repeat(20) })).rejects.toThrow(/REPORT_VERIFIER_ADDRESS/);
    await expect(start({ previous: [{ address, retiredAt: 1 }] })).rejects.toThrow(/current address/);
    for (const retiredAt of [Date.now(), Math.floor(Date.now() / 1000) + 3600]) {
      await expect(start({ previous: [{ address: '0x' + '44'.repeat(20), retiredAt }] })).rejects.toThrow(/unix seconds.*future/);
    }
    // the verifier key is secp256k1: an ed25519 key id refuses the start
    await expect(ReportVerifier.create(zktls, new LocalKms('x', { 'rv-1': 'ed25519' }), { keyId: 'rv-1', chains: CHAINS })).rejects.toThrow(/secp256k1/);
    // a misconfigured verifier never serves: attest and publicKey throw rather than sign
    const broken = new ReportVerifier(zktls, kms, { keyId: 'rv-1', chains: CHAINS, address: '0x' + '33'.repeat(20) });
    await expect(broken.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: incomeCommitment(figure, salt) }))).rejects.toThrow(VerifierConfigError);
    // the chain table may be loaded (the in-process dev verifier reads each simulator's ChainInfo.signing)
    expect((await (await ReportVerifier.create(zktls, kms, { keyId: 'rv-1', chains: async () => CHAINS })).publicKey()).chains).toEqual(CHAINS);
  });

  it('reads its chain table and previous addresses from the environment, computing each domain itself (S4-T2)', () => {
    const json = JSON.stringify([
      { chain: 'solana', family: 'solana', chainKind: 1, chainId: '103', registry: 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR' },
      { chain: 'monad', family: 'evm', chainKind: 2, chainId: 10143, registry: '0x1111111111111111111111111111111111111111' },
    ]);
    expect(verifierChainsFromEnv(json)).toEqual(CHAINS);
    // the known-answer domains (known_answers.json `domains`)
    expect(SOLANA_DEVNET.domain).toBe('0xf1700096cecfb3985168b292f6e6028dc1dc390168482f8c36ddc9ff7d424401');
    expect(MONAD_TESTNET.domain).toBe('0x055f03eaeadcbd5b740f5fdee071560491d2194963282e578b13e1aaa0607d46');
    for (const bad of [undefined, '', 'not json', '[]', '[{"chain":"x"}]', JSON.stringify([{ chain: 'solana', family: 'solana', chainKind: 2, chainId: '103', registry: 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR' }]), JSON.stringify([{ chain: 'solana', family: 'solana', chainKind: 1, chainId: '103', registry: 'nope', domain: '0x00' }])]) {
      expect(() => verifierChainsFromEnv(bad)).toThrow(VerifierConfigError);
    }
    expect(previousAddressesFromEnv(undefined)).toEqual([]);
    expect(previousAddressesFromEnv('[{"address":"0x' + '44'.repeat(20) + '","retiredAt":1775001600}]')).toEqual([{ address: '0x' + '44'.repeat(20), retiredAt: 1775001600 }]);
    for (const bad of ['x', '[{"address":"0x44"}]', '[{"address":"0x44","retiredAt":0}]']) expect(() => previousAddressesFromEnv(bad)).toThrow(VerifierConfigError);
  });

  it('development is the simulator only: MERCES_VERIFIER_DEV=true with a live chain in the table refuses to start, whatever the seed and pin (S4-T2, A-REV-9)', async () => {
    const entry = (chain: string, family: 'solana' | 'evm', chainId: string, registry: string) => ({ chain, family, chainKind: family === 'solana' ? 1 : 2, chainId, registry });
    const devnet = entry('solana', 'solana', '103', 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR');
    const testnet = entry('monad', 'evm', '10143', '0x1111111111111111111111111111111111111111');
    const localSol = entry('solana', 'solana', '104', SERIES_ADDRESS);
    const localEvm = entry('monad', 'evm', '31337', '0x2222222222222222222222222222222222222222');
    const secret = 'a-verifier-seed-of-at-least-32-characters';
    const env = (table: object[], over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ MERCES_VERIFIER_CHAINS: JSON.stringify(table), ...over });
    // the finding: dev mode, the dev seed (unset: the default), Solana devnet; and with a secret seed, a pin, or a testnet beside a local id
    for (const e of [
      env([devnet], { MERCES_VERIFIER_DEV: 'true' }),
      env([devnet], { MERCES_VERIFIER_DEV: 'true', MERCES_LOCAL_KEY_SEED: DEV_KEY_SEED }),
      env([devnet], { MERCES_VERIFIER_DEV: 'true', MERCES_LOCAL_KEY_SEED: secret, REPORT_VERIFIER_ADDRESS: '0x' + '33'.repeat(20) }),
      env([localSol, testnet], { MERCES_VERIFIER_DEV: 'true' }),
    ]) {
      expect(() => verifierSetupFromEnv(e)).toThrow(/MERCES_VERIFIER_DEV=true is for the simulator only/);
    }
    // development with local ids only: the dev seed, no pin, the local ids and nothing else (localOnly)
    const dev = verifierSetupFromEnv(env([localSol, localEvm], { MERCES_VERIFIER_DEV: 'true' }));
    expect(dev.seed).toBe(DEV_KEY_SEED);
    expect(dev.config).toMatchObject({ keyId: 'report-verifier-1', address: null, previous: [], allowLocal: true, localOnly: true });
    expect(dev.config.chains.map((c) => c.domain.chainId)).toEqual(['104', '31337']);
    const devKms = new LocalKms(dev.seed, { [dev.config.keyId]: 'secp256k1' });
    await expect(ReportVerifier.create(zktls, devKms, dev.config)).resolves.toBeInstanceOf(ReportVerifier);
    // the core refuses a live domain for a dev key too, at startup (in case a caller builds the config itself)
    await expect(ReportVerifier.create(zktls, devKms, { ...dev.config, chains: [...dev.config.chains, { chain: 'devnet', domain: SOLANA_DEVNET }] })).rejects.toThrow(/simulator only/);
    await expect(ReportVerifier.create(zktls, devKms, { keyId: dev.config.keyId, chains: CHAINS, localOnly: true })).rejects.toThrow(VerifierConfigError);
    // outside development: a secret seed (never the dev seed, set or defaulted) and the pin are required; the local ids are refused at startup
    expect(() => verifierSetupFromEnv(env([devnet]))).toThrow(/MERCES_LOCAL_KEY_SEED/);
    expect(() => verifierSetupFromEnv(env([devnet], { MERCES_LOCAL_KEY_SEED: DEV_KEY_SEED }))).toThrow(/MERCES_LOCAL_KEY_SEED/);
    expect(() => verifierSetupFromEnv(env([devnet], { MERCES_LOCAL_KEY_SEED: secret }))).toThrow(/REPORT_VERIFIER_ADDRESS is not set/);
    const liveKms = new LocalKms(secret, { 'report-verifier-1': 'secp256k1' });
    const pin = await liveKms.signerAddress('report-verifier-1');
    // Review finding 10: valid live secrets never make the published mock zkTLS proof authentic.
    for (const table of [[devnet], [testnet], [localSol, testnet]]) {
      expect(() => verifierSetupFromEnv(env(table, { MERCES_LOCAL_KEY_SEED: secret, REPORT_VERIFIER_ADDRESS: pin }))).toThrow(/mock zkTLS is simulator-only/);
    }
    expect(() => verifierSetupFromEnv(env([devnet], { MERCES_LOCAL_KEY_SEED: secret, REPORT_VERIFIER_ADDRESS: pin, MERCES_ZKTLS_PROVIDER: 'unwired' }))).toThrow(/not wired/);
    const localLive = verifierSetupFromEnv(env([localSol], { MERCES_LOCAL_KEY_SEED: secret, REPORT_VERIFIER_ADDRESS: pin }));
    await expect(ReportVerifier.create(zktls, liveKms, localLive.config)).rejects.toThrow(/not on the signing allow-list/);
    // a cloud KMS waits for the owner's choice (S4 question 1)
    expect(() => verifierSetupFromEnv(env([localSol], { MERCES_VERIFIER_DEV: 'true', MERCES_KMS_PROVIDER: 'aws' }))).toThrow(/cloud KMS not configured/);
  });

  it('serves over HTTP with logs that carry only ids, routes, outcome codes and timings', async () => {
    const lines: string[] = [];
    const server = createVerifierServer(verifier, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const client = new HttpReportVerifierClient(`http://127.0.0.1:${port}`);
    const proof = proofFor('2026Q1', figure, 'USD', 'deel');
    const ic = incomeCommitment(figure, salt);
    const ok = await client.attest(req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: ic }));
    expect(ok.ok).toBe(true);
    const bad = await client.attest(req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: '0x' + '00'.repeat(32) }));
    expect(bad).toEqual({ ok: false, code: 'commitment-mismatch' });
    // cause S4-T2: /keys serves the address and the chain table (was a key id and an SPKI)
    expect(await client.publicKey()).toEqual(await verifier.publicKey());
    const res = await fetch(`http://127.0.0.1:${port}/attest`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    // an unknown field (a stray figure) is refused, and its value is not echoed
    const stray = await fetch(`http://127.0.0.1:${port}/attest`, { method: 'POST', body: JSON.stringify({ ...req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: ic }), incomeYtd: figure.toString() }) });
    expect(stray.status).toBe(400);
    expect(await stray.text()).not.toContain(figure.toString());
    server.close();
    const text = lines.join('\n');
    expect(text).toContain('outcome=attested');
    expect(text).toContain('outcome=commitment-mismatch');
    expect(text).not.toContain(figure.toString());
    expect(text).not.toContain(salt);
    expect(text).not.toContain(ic);
  });
});

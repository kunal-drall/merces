import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { ChainError, E2E_TIER3_OPENING, SigningError, ZERO_INCOME_COMMITMENT, extinguishDigest, fxDigest, pauseDigest, recoverSigner, reportDigest, type SigningRequest, type UnsignedTx } from '@merces/domain';
import { WAD, parsePeriod, periodOf, ratePerUnit, wadFromDecimal } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { AttestorKey, assembleOnDevice, checkRequest, checkTier3Opening, describeSigningRequest, generateE2eKeyPair, openTier3Opening, pinNetworks, sealE2e, sealTier3Opening, signRequest } from '@merces/poi-device';
import { assertOpaqueCiphertext, assertTier3OpeningEnvelope } from '@merces/services';
import { SimSigner, type SimAttestor, type SimHarness } from '@merces/simulator';
import { project } from '@merces/indexer';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const DAY = 86_400;
/**
 * Pins that moved with Stage 1 (S1 WP12) carry a cause code:
 *  - R: Stage 1's report rules: the report opens the due without accrual; the first report of a reporting year chains
 *    from ZERO (SIM:1096-1103); a tier-3 report proves the same six public signals as tier 2 and binds the attestor's
 *    signature over the prior, the income commitment and liquidityEvent (SIM:1114-1118);
 *  - P: Stage 1's hardship pauses: `request_pause` carries no end, so the requested `until` is advisory; the attestor's
 *    `approve_pause` sets the end within Stage 1's bounds (`pauseApprovalError`: in the future, ≤ 1 year, ≤ 2 years in
 *    total, ≤ 16 pauses); `approve_pause` is a status sync point (SIM:1284-1297);
 *  - G7: an extinguishment returns only the unvested proceeds;
 *  - S4-ID: attestors are keys (S4 WP7): a secp256k1 key's 20-byte address, the same on both chains, linked to an
 *    account by its own proof (`rig.attestorToken`); access is per key and chain, read live; work is addressed to a key
 *    (a chain wallet address is no key: 400); `/attestor/me` lists the keys;
 *  - S4-T3: a tier-3 case is signed with Stage 1's REPORT message (tier 3) by the case's attestor key on its own device:
 *    the API issues the signing request (`GET /attestor/tier3/{caseId}/message`), the attestor tool (S4 WP8) checks it
 *    against its pinned networks and signs, the API recovers the signer (was the key's EIP-191 text); the issuer's report
 *    carries the stored signature and nobody co-signs;
 *  - S4-FX: an FX fallback is Stage 1's FX message signed once per covered series (`GET .../messages`, then
 *    `POST .../sign {rateWad, signer, sourceNote, signatures}`; was one EIP-191 text per pair); the issuer reads its
 *    series' signature as `fxFallback`.
 *  - S4-PAU: a hardship approval is the request key's Stage 1 PAUSE signature over the series' live pause nonce and the
 *    end, made by the attestor tool from `GET /attestor/hardship/{id}/message` and posted to `decide {approve, pauseEnd,
 *    pauseNonce, attestation}`; the keeper relays it (`approve_pause` is permissionless) and the decision returns the
 *    relay transaction (was `{approve, until}` returning an approvePause for the attestor to send);
 *  - S4-WD: the issuer withdraws a pending onchain request (`POST /series/{id}/hardship/build-withdraw`, Stage 1
 *    `withdraw_pause_request`); the indexer marks the hardship request withdrawn, and a signature collected for it is
 *    stale (409 `stale-nonce`).
 *  - S4-EXT: an extinguishment request names the caller's key and a co-attestor key of another account (`{attestor,
 *    coAttestor}`, S4 D15: 409 `same-account`); each named key signs Stage 1's EXTINGUISH message from
 *    `GET /attestor/extinguish/{id}/message` on its own device and posts it to `.../sign`; with both the keeper relays
 *    `extinguish` (permissionless) and the request is sent (was `{attestors}` returning a transaction the first attestor
 *    sent with the second co-signing). An unrelayed signature is never shown.
 */

/** The attestor's own device key for a harness attestor: the same published test key (its seed), in the tool's keystore type. */
const deviceKey = (a: { key: { seed: string } }) => AttestorKey.fromPrivateKey(deriveTestPrivateKey(a.key.seed));

/** The canary value the privacy suite scans the database and logs for (docs/SERVICES.md). */
const CANARY = '7317317317';

/** Stand-in for the client's end-to-end encryption: AES-256-GCM under a throwaway key the server never sees. */
function e2e(plain: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  // never a merces-e2e v1 version byte (0x01) first: one blob in 256 would otherwise parse as an envelope (a flake)
  if (iv[0] === 0x01) iv[0] = 0x00;
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

/** The attestor's X25519 key pair (its device keeps the private half); tier-3 openings are sealed for its public key. */
const ATTESTOR_E2E = generateE2eKeyPair();
/** A merces-e2e v1 envelope of an opening-sized payload, for requests refused for another reason. */
const sealedStub = () => sealE2e(JSON.stringify({ version: 'merces/tier3-opening/v1', note: 'stub'.repeat(20) }), ATTESTOR_E2E.publicKey, E2E_TIER3_OPENING.purpose);

describe.skipIf(!dbTestsEnabled())('E10 attestor service through the API (hardship, tier 3, FX fallback, extinguishment)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let h: SimHarness;
  let raise: Awaited<ReturnType<SimHarness['runRaise']>>;
  let seriesId: string;
  let issuerTok: string;
  let attTok: string;
  let att1Tok: string;
  let holderTok: string;
  let strangerTok: string;
  const HARDSHIP_PLAIN = `medical leave, see attached discharge summary; figure ${CANARY}`;
  const DOCS_PLAIN = `1040 Schedule C gross receipts ${CANARY}`;

  beforeAll(async () => {
    rig = await makeRig();
    h = rig.sol;
    raise = await h.runRaise();
    seriesId = raise.seriesId;
    await rig.sync();
    issuerTok = rig.token({ accountId: 'iss-1', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    // cause S4-ID: attestor access is the account's linked keys (the tokens carry no attestor wallet)
    attTok = await rig.attestorToken('att-0', [h.attestors[0]!]);
    att1Tok = await rig.attestorToken('att-1', [h.attestors[1]!]);
    holderTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    strangerTok = rig.token({ accountId: 'x', wallets: [{ chain: 'solana', address: 'nobody' }], roles: ['backer'] });
  });
  afterAll(async () => {
    await rig.close();
  });

  /**
   * cause S4-PAU: a decision body carrying the harness key's PAUSE signature over the series' live pause nonce and
   * `pauseEnd` (the WP8 tool signs the API's request in the first hardship test; this is the same signature, for the
   * refusals that come before the signature is checked and for the approvals that only move the clock).
   */
  const harnessDecision = async (sid: string, pauseEnd: number, att: SimAttestor = h.attestors[0]!) => {
    const series = (await h.sim.getSeries(sid))!;
    return { approve: true, pauseEnd: String(pauseEnd), pauseNonce: series.nonces.pause, attestation: await h.attestPause(sid, pauseEnd, att) };
  };

  it('access matrix: the queue, profile and attestor views are attestor-only; the profile shows onchain registration', async () => {
    expect((await rig.get('/attestor/queue')).statusCode).toBe(401);
    expect((await rig.get('/attestor/queue', issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/queue', holderTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/me', issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/fx-requests', holderTok)).statusCode).toBe(403);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestor: h.attestors[0]!.address, coAttestor: h.attestors[1]!.address, evidenceCiphertext: e2e('x') }, issuerTok)).statusCode).toBe(403); // cause S4-EXT
    // only the issuer opens hardship and tier-3 requests
    expect((await rig.post(`/series/${seriesId}/hardship`, { until: 1, attestor: h.attestors[0]!.address, ciphertext: e2e('x') }, holderTok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/tier3/2026Q1`, { attestor: h.attestors[0]!.address, documentsCiphertext: e2e('x'), estimatePaymentStable: '1' }, attTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/tier3`, holderTok)).statusCode).toBe(403);
    // the holder view of hardship is for holders and the issuer, not strangers
    expect((await rig.get(`/series/${seriesId}/hardship`, strangerTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/hardship`, holderTok)).statusCode).toBe(200);

    const me = await rig.get('/attestor/me', attTok);
    expect(me.statusCode).toBe(200);
    // cause S4-ID: the account's linked key, on each chain with its registration there (both rig chains register it)
    expect(me.json().keys).toEqual([{ chain: 'monad', address: h.attestors[0]!.address, registeredOnchain: true }, { chain: 'solana', address: h.attestors[0]!.address, registeredOnchain: true }]);
    expect(me.json().wallets).toBeUndefined();
    expect(me.json().openWork).toEqual({ hardship: 0, tier3: 0, tier3Annual: 0, fxRequests: 0, amendments: 0, extinguishments: 0 });
    // a token claiming the attestor role for a wallet the chain has not registered gets no attestor routes at all
    const unregistered = rig.token({ accountId: 'att-x', wallets: [{ chain: 'solana', address: h.backers[4]!.address }], roles: ['attestor'] });
    expect((await rig.get('/attestor/me', unregistered)).statusCode).toBe(403);
    // cause S4-ID: nor does a token naming a registered key among its wallets, when the key is not linked to the account
    const notLinked = rig.token({ accountId: 'att-y', wallets: [{ chain: 'solana', address: h.attestors[0]!.address }], roles: ['attestor'] });
    expect((await rig.get('/attestor/me', notLinked)).statusCode).toBe(403);
    // nor a linked key the chains never registered
    expect((await rig.get('/attestor/me', await rig.attestorToken('att-z', [SimSigner.attestor('never-registered')]))).statusCode).toBe(403);
    const q = await rig.get('/attestor/queue', attTok);
    expect(q.statusCode).toBe(200);
    expect(q.json()).toEqual({ hardship: [], tier3: [], tier3Annual: [], fxRequests: [], amendments: [], extinguishments: [] });
  });

  it('tier 3: case → client-side prefill spec → the attestor tool signs the REPORT request fetched from the API → issuer assembles via E5 → annual true-up', async () => {
    const att = h.attestors[0]!;
    const periodId = '2026Q1';
    // the quarter has not ended yet
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: e2e(DOCS_PLAIN), estimatePaymentStable: USDC(1800).toString() }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(parsePeriod(periodId).end + DAY);
    // plaintext documents are refused
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: JSON.stringify({ documents: ['1040'], grossReceipts: CANARY }), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: Buffer.from(JSON.stringify({ grossReceipts: CANARY, note: 'x' })).toString('base64'), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
    // unknown attestor: a key no chain registered (422); a chain wallet address is no key (cause S4-ID: 400)
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: SimSigner.attestor('never-registered').address, openingCiphertext: sealedStub(), documentsCiphertext: e2e(DOCS_PLAIN), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: h.backers[0]!.address, openingCiphertext: sealedStub(), documentsCiphertext: e2e(DOCS_PLAIN), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(400);
    // the issuer's device proves the quarter (Stage 1 Groth16); the opening goes to the attestor end to end encrypted (M7)
    const dev = await assembleOnDevice({ seriesId, periodId, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', privateTerms: { threshold: raise.privateTerms.theta.toString(), ratePerUnitWad: raise.privateTerms.rWad.toString(), reportingCurrency: 'USD', indexingRule: raise.privateTerms.indexingRule, termsSalt: raise.privateTerms.termsSalt.toString() }, prior: null, incomeYtdNow: USDC(80_000), fxAvgWad: WAD, tier: 3, source: 'attestor', deviceSecret: 'issuer-device-secret' }, null);
    expect(dev.assembled.paymentStable).toBe(USDC(2000).toString());
    const opening = dev.tier3Opening!;
    // the opening must be a merces-e2e v1 envelope: plaintext, any encoding of it (S1 review: bare hex was stored), and
    // ciphertext in another format are refused, and nothing is stored
    const raw = Buffer.from(JSON.stringify(opening));
    for (const bad of [JSON.stringify(opening), raw.toString('hex'), raw.toString('hex').toUpperCase(), '0x' + raw.toString('hex'), raw.toString('base64'), raw.toString('base64url'), e2e(JSON.stringify(opening))]) {
      const r = await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, documentsCiphertext: e2e(DOCS_PLAIN), openingCiphertext: bad, estimatePaymentStable: '1' }, issuerTok);
      expect(r.statusCode, bad.slice(0, 40)).toBe(422);
      expect(r.json().message).toMatch(/^openingCiphertext must be a merces-e2e v1 envelope sealed for the attestor: /);
      expect(r.body).not.toContain(opening.incomeYtd);
    }
    expect((await rig.t.pool.query('select count(*)::int as n from tier3_cases where series_id = $1', [seriesId])).rows[0].n).toBe(0);
    const docs = e2e(DOCS_PLAIN);
    const openingCiphertext = sealTier3Opening(opening, ATTESTOR_E2E.publicKey);
    const opened = await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, documentsCiphertext: docs, openingCiphertext, keyHint: 'attestor-1 x25519 key v1', estimatePaymentStable: USDC(1800).toString() }, issuerTok, { 'idempotency-key': 't3-q1' });
    expect(opened.statusCode, JSON.stringify(opened.json())).toBe(201);
    const caseId = opened.json().caseId as string;
    expect(opened.json()).toMatchObject({ state: 'open', periodId, attestor: att.address, estimatePaymentStable: USDC(1800).toString() });
    expect(opened.json().documentsCiphertext).toBeUndefined();
    expect(opened.json().openingCiphertext).toBeUndefined();
    // replay returns the same case; a second case for the period is refused
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, documentsCiphertext: docs, openingCiphertext, keyHint: 'attestor-1 x25519 key v1', estimatePaymentStable: USDC(1800).toString() }, issuerTok, { 'idempotency-key': 't3-q1' })).json().caseId).toBe(caseId);
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, documentsCiphertext: e2e(DOCS_PLAIN), openingCiphertext: sealedStub(), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(409);

    // the case is on the chosen attestor's queue only; only they (or an admin) read the ciphertext
    expect((await rig.get('/attestor/queue', attTok)).json().tier3.map((c: { caseId: string }) => c.caseId)).toEqual([caseId]);
    expect((await rig.get('/attestor/queue', att1Tok)).json().tier3).toEqual([]);
    expect((await rig.get(`/attestor/tier3/${caseId}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/tier3/${caseId}`, issuerTok)).statusCode).toBe(403);
    const view = await rig.get(`/attestor/tier3/${caseId}`, attTok);
    expect(view.statusCode).toBe(200);
    expect(view.json().documentsCiphertext).toBe(docs);
    expect(view.json().openingCiphertext).toBe(openingCiphertext);
    expect(view.json()).toMatchObject({ reportingCurrency: 'USD', unitsOutstanding: '500', termsCommitment: raise.terms.termsCommitment });
    const spec = await rig.get(`/attestor/tier3/${caseId}/prefill-spec`, attTok);
    expect(spec.statusCode).toBe(200);
    expect(spec.json()).toMatchObject({ version: 'tier3-prefill/v1', extraction: 'client-side', currency: 'USD', termsCommitment: raise.terms.termsCommitment });
    expect(spec.json().period).toMatchObject({ start: parsePeriod(periodId).start, end: parsePeriod(periodId).end });
    const fields = spec.json().documents.flatMap((d: { fields: { name: string }[] }) => d.fields.map((f) => f.name));
    expect(fields).toEqual(expect.arrayContaining(['grossReceipts', 'w2Wages', 'form1099Totals', 'royalties']));
    // cause S4-T3: the spec points at the signing request and the attestor tool, never at a text to sign with a wallet
    expect(spec.json().sign).toMatch(/\/attestor\/tier3\/.+\/message/);
    expect(spec.json().sign).toMatch(/merces-attestor sign/);
    expect(JSON.stringify(spec.json())).not.toMatch(/personal_sign|EIP-191|merces\/attestation\/v1/);

    // attestor device: open the envelope with its private key, check the opening against the documents
    expect(openTier3Opening(view.json().openingCiphertext, ATTESTOR_E2E.privateKey)).toEqual(opening);
    const c = { seriesId, periodId, priorIncomeCommitment: dev.assembled.priorIncomeCommitment, incomeCommitment: dev.assembled.incomeCommitment };
    // 2026Q1 is the series' first report and a year start: the prior the attestor signs over is ZERO (cause R)
    expect(c.priorIncomeCommitment).toBe(ZERO_INCOME_COMMITMENT);
    expect(checkTier3Opening(opening, { ...c, documentedYtd: USDC(80_000) })).toEqual({ ok: true });

    // cause S4-T3, end to end: the API issues Stage 1's REPORT signing request (tier 3) for the case's key, the attestor tool
    // (S4 WP8) checks it against the device's own pinned network table and signs it; the API never signs
    const qs = (o: { priorIncomeCommitment: string; incomeCommitment: string; liquidityEvent: boolean | string }) => `priorIncomeCommitment=${o.priorIncomeCommitment}&incomeCommitment=${o.incomeCommitment}&liquidityEvent=${o.liquidityEvent}`;
    const msgUrl = `/attestor/tier3/${caseId}/message?${qs({ ...c, liquidityEvent: false })}`;
    expect((await rig.get(msgUrl, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(msgUrl, issuerTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/tier3/${caseId}/message?${qs({ ...c, liquidityEvent: 'yes' })}`, attTok)).statusCode).toBe(400);
    expect((await rig.get(`/attestor/tier3/${caseId}/message?priorIncomeCommitment=${c.priorIncomeCommitment}`, attTok)).statusCode).toBe(400);
    // a prior the chain will not take is nothing to sign
    expect((await rig.get(`/attestor/tier3/${caseId}/message?${qs({ ...c, priorIncomeCommitment: c.incomeCommitment, liquidityEvent: false })}`, attTok)).json()).toMatchObject({ detail: { expectedPrior: ZERO_INCOME_COMMITMENT } });
    const msg = await rig.get(msgUrl, attTok);
    expect(msg.statusCode, msg.body).toBe(200);
    const signing = (await h.sim.info()).signing!;
    const seriesKey = (await h.sim.getSeries(seriesId))!.seriesKey;
    expect(msg.json()).toMatchObject({ kind: 'REPORT', chain: h.sim.chain, seriesId, seriesKey, domain: signing, signer: att.address, fields: { periodId, priorIncomeCommitment: c.priorIncomeCommitment, incomeCommitment: c.incomeCommitment, tier: 3, liquidityEvent: false } });
    expect(msg.json().digest).toBe(reportDigest({ domain: signing.domain, seriesKey }, { ...c, tier: 3, liquidityEvent: false }).digest);
    // the request carries no figure, no salt and no display text
    expect(msg.body).not.toContain(opening.incomeYtd);
    expect(msg.body).not.toContain(opening.incomeSalt);
    expect(msg.json()).not.toHaveProperty('display');
    // the device: its own pinned networks (the simulator's local domain, allowLocal), its own key; it refuses a request
    // whose typed fields were changed under the digest, and another chain's
    const request = msg.json() as SigningRequest<'REPORT'>;
    const device = deviceKey(att);
    expect(device.address).toBe(att.address);
    const pinned = pinNetworks({ [h.sim.chain]: signing }, { allowLocal: true });
    const monadOnly = pinNetworks({ [rig.mon.sim.chain]: (await rig.mon.sim.info()).signing! }, { allowLocal: true });
    expect(() => signRequest({ ...request, fields: { ...request.fields, liquidityEvent: true } }, device, pinned, { allowLocal: true })).toThrow(SigningError);
    expect(() => signRequest(request, device, monadOnly, { allowLocal: true })).toThrow(/not in this device's pinned network table/);
    expect(() => signRequest(request, deviceKey(h.attestors[1]!), pinned, { allowLocal: true })).toThrow(/key/);
    expect(describeSigningRequest(checkRequest(request, pinned, { allowLocal: true })).join('\n')).toMatch(/^Tier-3 report attestation \(MERCES_REPORT_V1\) for period 2026Q1/);
    const sig = signRequest(request, device, pinned, { allowLocal: true });
    expect(sig).toEqual({ signer: att.address, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), digest: msg.json().digest });
    expect(recoverSigner(sig.digest, sig.signature)).toBe(att.address);
    device.wipe();
    const signBody = { priorIncomeCommitment: c.priorIncomeCommitment, incomeCommitment: c.incomeCommitment, liquidityEvent: false, proof: dev.assembled.proof, attestation: sig };
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, att1Tok)).statusCode).toBe(403);
    // the API recovers the signer over the message it rebuilds from the chain's own reads: another key's signature, another
    // signer named, a signature over another flag or tier, a digest that is not this message: 422 InvalidAttestorSignature
    const otherKey = signRequest({ ...request, signer: h.attestors[1]!.address }, deviceKey(h.attestors[1]!), pinned, { allowLocal: true });
    const refused = async (body: unknown, status = 422) => {
      const r = await rig.post(`/attestor/tier3/${caseId}/sign`, body, attTok);
      expect(r.statusCode, r.body).toBe(status);
      return r.json();
    };
    expect((await refused({ ...signBody, attestation: { ...otherKey, signer: att.address } })).detail).toEqual({ stage1: 'InvalidAttestorSignature' });
    expect((await refused({ ...signBody, attestation: otherKey })).detail).toEqual({ stage1: 'InvalidAttestorSignature' });
    expect((await refused({ ...signBody, liquidityEvent: true })).message).toMatch(/digest/);
    expect((await refused({ ...signBody, liquidityEvent: true, attestation: { signer: sig.signer, signature: sig.signature } })).message).toMatch(/does not recover/);
    const tier2 = await att.attest('REPORT', signing, seriesKey, { ...c, tier: 2, liquidityEvent: false });
    expect((await refused({ ...signBody, attestation: { signer: tier2.signer, signature: tier2.signature } })).detail).toEqual({ stage1: 'InvalidAttestorSignature' });
    // a non-canonical signature (v outside {27, 28}) recovers to nobody: 422; a wrong shape is 400
    await refused({ ...signBody, attestation: { signer: sig.signer, signature: sig.signature.slice(0, -2) + '1d' } });
    // the old shapes: the EIP-191 text signature {liquidityEvent, signature}, a simulator signature (cause S4-T3: 400)
    await refused({ ...signBody, attestation: { liquidityEvent: false, signature: sig.signature } }, 400);
    await refused({ ...signBody, attestation: { signer: sig.signer, signature: await att.signMessage(new Uint8Array([1])) } }, 400);
    // the sign body carries commitments, the proof and the attestation only: an opening field is refused (strict)
    await refused({ ...signBody, incomeYtd: opening.incomeYtd }, 400);
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, { ...signBody, incomeCommitment: c.priorIncomeCommitment }, attTok)).statusCode).toBe(422); // proof over other commitments
    const signed = await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, attTok, { 'idempotency-key': 't3-sign-q1' });
    expect(signed.statusCode, JSON.stringify(signed.json())).toBe(200);
    expect(signed.json()).toMatchObject({ state: 'signed', decisionCode: null, attestedPaymentStable: USDC(2000).toString(), incomeCommitment: c.incomeCommitment, priorIncomeCommitment: c.priorIncomeCommitment, attestation: sig });
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, attTok)).statusCode).toBe(409);
    expect((await rig.get(msgUrl, attTok)).statusCode).toBe(409);
    expect((await rig.get('/attestor/queue', attTok)).json().tier3).toEqual([]);
    const forIssuer = await rig.get(`/series/${seriesId}/tier3`, issuerTok);
    expect(forIssuer.json().cases[0]).toMatchObject({ caseId, state: 'signed', attestedPaymentStable: USDC(2000).toString(), attestation: sig });
    expect(JSON.stringify(forIssuer.json())).not.toContain(docs.slice(0, 32));
    expect(JSON.stringify(forIssuer.json())).not.toContain(openingCiphertext.slice(0, 32));

    // the issuer assembles the tier-3 report through E5: the service carries the attestor's stored REPORT signature, and the
    // issuer sends it alone (cause S4-T3: was the attestor as co-signer; the old `attestor` field is refused, strict)
    expect((await rig.post(`/series/${seriesId}/reports`, { ...dev.assembled, attestor: att.address }, issuerTok)).statusCode).toBe(400);
    expect((await rig.post(`/series/${seriesId}/reports`, { ...dev.assembled, attestation: { signer: otherKey.signer, signature: otherKey.signature } }, issuerTok)).statusCode).toBe(422);
    // cause S4-T3: a key revoked after the quarter ended still attests it within Stage 1's 45-day grace (forward-only
    // revocation): the service checks the stored signature against the chain's key record with the grace, as the chain
    // does when the report lands; the key is registered again after the quarter is paid
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: att.address });
    expect(await h.sim.getSignerKey('attestor', att.address)).toMatchObject({ active: false, graceUntil: expect.any(Number) });
    const rep = await rig.post(`/series/${seriesId}/reports`, dev.assembled, issuerTok, { 'idempotency-key': 't3-rep-q1' });
    expect(rep.statusCode, JSON.stringify(rep.json())).toBe(201);
    expect(rep.json()).toMatchObject({ tier: 3, verifiedOffchain: true, paymentStable: USDC(2000).toString(), attestor: att.address });
    const reportId = rep.json().reportId as string;
    const tx = rep.json().tx as UnsignedTx;
    expect(tx.command).toMatchObject({ kind: 'submitReport', tier: 3, attestation: { signer: att.address, signature: sig.signature }, fxFallback: null });
    expect(tx.command).not.toHaveProperty('attestor');
    expect(tx.coSigners ?? []).toEqual([]);
    const sent = await rig.post('/tx/send', await h.issuer.sign(tx), issuerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const accepted = sent.json().events.find((e: { type: string }) => e.type === 'ReportAccepted');
    // 10% × (80,000 − 60,000) = 2,000 due, no accrual at the report (cause R), chained from ZERO
    expect(accepted.payload).toMatchObject({ tier: 3, paymentDue: USDC(2000).toString(), accrual: '0', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: c.incomeCommitment });
    expect((await rig.post(`/reports/${reportId}/submitted`, { txId: sent.json().txId }, issuerTok)).json().state).toBe('accepted');
    const pay = await rig.post(`/reports/${reportId}/build-payin`, {}, issuerTok);
    expect(pay.json().amount).toBe(USDC(2000).toString());
    expect((await rig.post('/tx/send', await h.issuer.sign(pay.json().tx), issuerTok)).statusCode).toBe(200);
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: att.address }); // active again for the tests below
    await rig.sync();

    // annual true-up: the year must be over
    expect((await rig.post(`/series/${seriesId}/tier3/annual`, { year: 2026, attestor: att.address, documentsCiphertext: e2e(DOCS_PLAIN) }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(parsePeriod('2026Q4').end + DAY);
    const annual = await rig.post(`/series/${seriesId}/tier3/annual`, { year: 2026, attestor: att.address, documentsCiphertext: e2e(DOCS_PLAIN), keyHint: 'attestor-1 x25519 key v1' }, issuerTok, { 'idempotency-key': 't3-annual-2026' });
    expect(annual.statusCode, JSON.stringify(annual.json())).toBe(201);
    const annualId = annual.json().annualId as string;
    expect((await rig.post(`/series/${seriesId}/tier3/annual`, { year: 2026, attestor: att.address, documentsCiphertext: e2e(DOCS_PLAIN) }, issuerTok)).statusCode).toBe(409);
    expect((await rig.get('/attestor/queue', attTok)).json().tier3Annual.map((a: { annualId: string }) => a.annualId)).toEqual([annualId]);
    expect((await rig.get(`/attestor/tier3/annual/${annualId}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/tier3/annual/${annualId}`, attTok)).json().documentsCiphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    // the attestor finds the year's payment was 2500 USDC; 2000 USDC was paid on estimate → 500 USDC due within 60 days, no accrual
    const now = await h.sim.now();
    const trued = await rig.post(`/attestor/tier3/annual/${annualId}/sign`, { totalPaymentStable: USDC(2500).toString() }, attTok, { 'idempotency-key': 't3-annual-sign' });
    expect(trued.statusCode, JSON.stringify(trued.json())).toBe(200);
    expect(trued.json()).toMatchObject({ state: 'signed', totalPaymentStable: USDC(2500).toString(), estimatedPaymentStable: USDC(2000).toString(), underpayment: USDC(500).toString(), overpayment: '0', trueUpDueAt: now + 60 * DAY, creditPeriodId: null });
    expect((await rig.post(`/attestor/tier3/annual/${annualId}/sign`, { totalPaymentStable: '1' }, attTok)).statusCode).toBe(409);
    expect((await rig.get(`/series/${seriesId}/tier3`, issuerTok)).json().annual[0]).toMatchObject({ annualId, underpayment: USDC(500).toString() });
    const audit = await rig.t.pool.query('select action from audit_log where target in ($1, $2) order by id', [caseId, annualId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['tier3.sign', 'tier3.annual-sign']);
  });

  it('FX fallback: the keeper opens a request, an attestor\'s device signs Stage 1\'s FX message per covered series, the issuer reads its own', async () => {
    const att = h.attestors[1]!;
    const eurTerms = (salt: string) => ({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'EUR', indexingRule: 'cpi-annual' as const, termsSalt: BigInt('0x' + salt.repeat(31)) }, terms: { reportingCurrency: 'EUR' } });
    // two EUR series on the chain, both reporting the quarter: one rate, one signature each (S4 D14)
    const eur = await h.runRaise(eurTerms('55'));
    const eur2 = await h.runRaise(eurTerms('56'));
    const q = periodOf(await h.sim.now());
    await h.sim.setTime(q.end + DAY);
    await rig.sync();
    // the rate keeper (E8) flags the quarter and opens the request (keepers' openFallback); no snapshots → coverage
    const quarter = await h.sim.getQuarterRate('EUR/USD', q.id);
    expect(quarter?.needsFallback).toBe(true);
    await rig.t.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5)', ['fxreq_test1', 'solana', 'EUR/USD', q.id, 'coverage']);
    // a monad request is not on a solana-only attestor's list
    await rig.t.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5)', ['fxreq_test2', 'monad', 'EUR/USD', q.id, 'coverage']);
    // cause S4-ID: a key is the attestor on every chain that registered it; one registered on solana only sees solana's
    // requests, one registered on monad only monad's, and the harness keys (registered on both) both
    const solOnly = SimSigner.attestor('fx-solana-only');
    const monOnly = SimSigner.attestor('fx-monad-only');
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: solOnly.address });
    await rig.mon.exec(rig.mon.admin, { kind: 'registerAttestor', attestor: monOnly.address });
    await rig.sync();
    const solTok = await rig.attestorToken('att-sol-only', [solOnly]);
    const list = await rig.get('/attestor/fx-requests', solTok);
    expect(list.json().requests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test1']);
    expect((await rig.get('/attestor/queue', solTok)).json().fxRequests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test1']);
    const monadAtt = await rig.attestorToken('att-m', [monOnly]);
    expect((await rig.get('/attestor/fx-requests', monadAtt)).json().requests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test2']);
    expect((await rig.get('/attestor/fx-requests', att1Tok)).json().requests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test1', 'fxreq_test2']);
    // before any signature the issuer sees the open request and no rate (cause S4-FX: `fxFallback`, was `attestorRate`)
    expect((await rig.get(`/series/${eur.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ pair: 'EUR/USD', basis: 'attestor', state: 'open', rateWad: null, seriesSigned: false, fxFallback: null });
    expect((await rig.get(`/series/${seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ basis: 'unity', fxFallback: null });

    // cause S4-FX: the signing requests, one per covered series (the USD series is not covered), for the caller's key
    const rateWad = wadFromDecimal('1.08').toString();
    const signing = (await h.sim.info()).signing!;
    const keyOf = async (id: string) => (await h.sim.getSeries(id))!.seriesKey;
    const covered = [eur.seriesId, eur2.seriesId].sort();
    const msgs = await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=${rateWad}`, att1Tok);
    expect(msgs.statusCode, msgs.body).toBe(200);
    expect(msgs.json()).toMatchObject({ requestId: 'fxreq_test1', pair: 'EUR/USD', periodId: q.id, state: 'open', signer: att.address, rateWad });
    const requests = msgs.json().requests as { seriesId: string; digest: string; fields: unknown }[];
    expect(requests.map((r) => r.seriesId)).toEqual(covered);
    for (const r of requests) {
      expect(r).toMatchObject({ kind: 'FX', chain: h.sim.chain, domain: signing, signer: att.address, fields: { periodId: q.id, fxRateWad: rateWad } });
      expect(r.digest).toBe(fxDigest({ domain: signing.domain, seriesKey: await keyOf(r.seriesId) }, { periodId: q.id, fxRateWad: rateWad }).digest);
    }
    // the message binds the series key: the two digests differ
    expect(new Set(requests.map((r) => r.digest)).size).toBe(2);
    // another account's key, a key not on the request's chain, a zero rate, an unknown field
    expect((await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=${rateWad}&attestor=${h.attestors[0]!.address}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/fx-requests/fxreq_test2/messages?rateWad=${rateWad}`, solTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/fx-requests/fxreq_test1/messages?rateWad=0', att1Tok)).statusCode).toBe(400);
    expect((await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=${rateWad}&pair=EUR/USD`, att1Tok)).statusCode).toBe(400);
    // the attestor's device checks each request against its pinned networks and signs it
    const device = deviceKey(att);
    const pinned = pinNetworks({ [h.sim.chain]: signing }, { allowLocal: true });
    const sigs = requests.map((r) => ({ seriesId: r.seriesId, ...signRequest(r, device, pinned, { allowLocal: true }) }));
    const signatures = sigs.map((x) => ({ seriesId: x.seriesId, signature: x.signature }));
    const body = { rateWad, signer: att.address, sourceNote: 'ecb-reference-rate', signatures };
    const refused = async (b: unknown, status: number, tok = att1Tok) => {
      const r = await rig.post('/attestor/fx-requests/fxreq_test1/sign', b, tok);
      expect(r.statusCode, r.body).toBe(status);
      return r.json();
    };
    // a key not linked to the session; another key's signature; series A's signature for series B (cause S4-FX: one
    // signature per series); a signature over another rate; a non-canonical one: each 422 InvalidAttestorSignature
    await refused({ ...body, signer: h.attestors[0]!.address }, 403);
    const byOther = requests.map((r) => ({ seriesId: r.seriesId, signature: signRequest({ ...r, signer: h.attestors[0]!.address }, deviceKey(h.attestors[0]!), pinned, { allowLocal: true }).signature }));
    expect((await refused({ ...body, signatures: byOther }, 422)).detail).toMatchObject({ stage1: 'InvalidAttestorSignature' });
    const swapped = [{ seriesId: signatures[0]!.seriesId, signature: signatures[1]!.signature }, { seriesId: signatures[1]!.seriesId, signature: signatures[0]!.signature }];
    expect((await refused({ ...body, signatures: swapped }, 422)).detail).toEqual({ stage1: 'InvalidAttestorSignature', seriesId: signatures[0]!.seriesId });
    expect((await refused({ ...body, rateWad: '1090000000000000000' }, 422)).detail).toMatchObject({ stage1: 'InvalidAttestorSignature' });
    await refused({ ...body, signatures: [{ ...signatures[0]!, signature: signatures[0]!.signature.slice(0, -2) + '1d' }, signatures[1]!] }, 422);
    // every covered series must be signed while the request is open; a series it does not cover, or twice, is refused
    expect((await refused({ ...body, signatures: [signatures[0]!] }, 422)).detail).toEqual({ reason: 'signatures-missing', missing: [signatures[1]!.seriesId] });
    expect((await refused({ ...body, signatures: [...signatures, { seriesId, signature: signatures[0]!.signature }] }, 422)).detail).toEqual({ reason: 'series-not-covered', seriesId });
    expect((await refused({ ...body, signatures: [...signatures, signatures[0]!] }, 422)).detail).toMatchObject({ reason: 'duplicate-series' });
    // the old shape (one EIP-191 text signature, `attestor`), a simulator signature, a free-text source note: 400
    await refused({ rateWad, attestor: att.address, sourceNote: 'ecb-reference-rate', signature: signatures[0]!.signature }, 400);
    await refused({ ...body, signatures: [{ seriesId: eur.seriesId, signature: 'sim:deadbeef' }] }, 400);
    await refused({ ...body, sourceNote: 'ECB said 1.08 today' }, 400);
    expect((await rig.t.pool.query('select count(*)::int as n from fx_fallback_signatures')).rows[0].n).toBe(0);
    const signed = await rig.post('/attestor/fx-requests/fxreq_test1/sign', body, att1Tok, { 'idempotency-key': 'fx-1' });
    expect(signed.statusCode, JSON.stringify(signed.json())).toBe(200);
    expect(signed.json()).toMatchObject({ state: 'signed', attestor: att.address, rateWad, sourceNote: 'ecb-reference-rate', decisionCode: null });
    expect(signed.json().signatures.map((x: { seriesId: string; signer: string; signature: string; digest: string }) => [x.seriesId, x.signer, x.signature, x.digest])).toEqual(sigs.map((x) => [x.seriesId, att.address, x.signature, x.digest]));
    // signed: the same body again is a conflict, another rate for the period is refused (409 rate-fixed)
    await refused(body, 409);
    expect((await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=1090000000000000000`, att1Tok)).json().detail).toEqual({ reason: 'rate-fixed', rateWad });
    expect((await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=${rateWad}`, att1Tok)).json().requests).toEqual([]);
    expect((await rig.get('/attestor/fx-requests', solTok)).json().requests).toEqual([]);
    // the issuer reads its own series' signature, as the report will carry it (the poi service carries the stored one)
    const forIssuer = await rig.get(`/series/${eur.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok);
    const own = sigs.find((x) => x.seriesId === eur.seriesId)!;
    expect(forIssuer.json()).toMatchObject({ pair: 'EUR/USD', state: 'signed', rateWad, seriesSigned: true, fxFallback: { signer: att.address, signature: own.signature }, digest: own.digest });
    expect(recoverSigner(own.digest, own.signature)).toBe(att.address);
    // a series that starts reporting the period after the rate was signed (here: its signature removed, as if it had been
    // indexed later) is added at the same rate, by any registered key
    await rig.t.pool.query('delete from fx_fallback_signatures where series_id = $1', [eur2.seriesId]);
    expect((await rig.get(`/series/${eur2.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ state: 'signed', seriesSigned: false, fxFallback: null });
    const topUp = await rig.get(`/attestor/fx-requests/fxreq_test1/messages?rateWad=${rateWad}`, solTok);
    expect(topUp.json().requests.map((r: { seriesId: string }) => r.seriesId)).toEqual([eur2.seriesId]);
    const solDevice = AttestorKey.fromPrivateKey(deriveTestPrivateKey(solOnly.seed));
    const added = await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, signer: solOnly.address, sourceNote: 'ecb-reference-rate', signatures: [{ seriesId: eur2.seriesId, signature: signRequest(topUp.json().requests[0], solDevice, pinned, { allowLocal: true }).signature }] }, solTok);
    expect(added.statusCode, added.body).toBe(200);
    expect((await rig.get(`/series/${eur2.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ seriesSigned: true, fxFallback: { signer: solOnly.address } });
    // the request keeps its first signer and rate
    expect(added.json()).toMatchObject({ attestor: att.address, rateWad });
    const audit = await rig.t.pool.query("select detail from audit_log where action = 'fx.sign' and target = 'fxreq_test1' order by id");
    expect(audit.rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({ pair: 'EUR/USD', rateWad, sourceNote: 'ecb-reference-rate', attestor: att.address, seriesIds: covered }),
      expect.objectContaining({ attestor: solOnly.address, seriesIds: [eur2.seriesId] }),
    ]);
  });

  it('hardship: E2E ciphertext only, private review by the chosen attestor, the attestor tool signs the PAUSE request, the keeper relays it, holders see statuses only', async () => {
    const att = h.attestors[0]!;
    const now = await h.sim.now();
    const until = now + 90 * DAY;
    // plaintext-looking payloads are refused before anything is stored
    // (S1 review: hex and base64 encodings of plain text are refused too, whichever words it uses)
    const leave = 'leave from 2026-01-01 to 2026-04-01, letter from my doctor attached';
    for (const bad of [JSON.stringify({ reason: 'medical', until }), 'my hardship reason is a long medical leave this year', Buffer.from(JSON.stringify({ reason: 'medical' })).toString('base64'), 'short',
      Buffer.from('medical diagnosis, salary cut').toString('hex'), Buffer.from(leave).toString('hex').toUpperCase(), Buffer.from(leave).toString('base64'), Buffer.from(leave).toString('base64url')]) {
      const r = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext: bad }, issuerTok);
      expect(r.statusCode, bad).toBe(422);
    }
    expect((await rig.t.pool.query('select count(*)::int as n from hardship_requests')).rows[0].n).toBe(0);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until: now - 1, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(422);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: SimSigner.attestor('never-registered').address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(422);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.backers[1]!.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(400); // cause S4-ID: a wallet is no key

    const ciphertext = e2e(HARDSHIP_PLAIN);
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext, keyHint: 'attestor-1 x25519 key v1' }, issuerTok, { 'idempotency-key': 'hard-1' });
    expect(req.statusCode, JSON.stringify(req.json())).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    expect(req.json()).toMatchObject({ state: 'pending', requestedUntil: until, attestor: att.address, pauseNonce: null });
    expect(req.json().ciphertext).toBeUndefined();
    expect(req.json()).not.toHaveProperty('approval');
    const tx = req.json().tx as UnsignedTx;
    expect(tx.command).toEqual({ kind: 'requestPause', seriesId, until });
    expect(tx.signer).toBe(h.issuer.address);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext, keyHint: 'attestor-1 x25519 key v1' }, issuerTok, { 'idempotency-key': 'hard-1' })).json().hardshipId).toBe(hardshipId);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(409);

    // the attestor can neither get a PAUSE request nor approve before the issuer's requestPause landed (Stage 1's
    // PauseNotRequested); cause S4-PAU: a decision carries the key's PAUSE signature over the nonce and the end
    const approvedUntil = until - 30 * DAY;
    const earlyMsg = await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}`, attTok);
    expect([earlyMsg.statusCode, earlyMsg.json().detail]).toEqual([409, { stage1: 'PauseNotRequested' }]);
    const early = await rig.post(`/attestor/hardship/${hardshipId}/decide`, await harnessDecision(seriesId, approvedUntil), attTok);
    expect(early.statusCode).toBe(409);
    expect(early.json().detail).toEqual({ stage1: 'PauseNotRequested' });
    const sent = await rig.post('/tx/send', await h.issuer.sign(tx), issuerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    expect(sent.json().events[0]).toMatchObject({ type: 'PauseRequested', payload: { seriesId, until, nonce: '1' } }); // cause S4-PAU: with the nonce
    // the requested end is advisory: recorded beside the request, no pause yet (cause P)
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 0, requested: true, requestedUntil: until, current: null });
    // the indexer ties the pending request to its onchain request's nonce
    await rig.sync();

    // private review: only the chosen attestor (or an admin) reads the ciphertext and gets the signing request
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, issuerTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}`, issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/queue', att1Tok)).json().hardship).toEqual([]);
    expect((await rig.get('/attestor/queue', attTok)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).toEqual([hardshipId]);
    const view = await rig.get(`/attestor/hardship/${hardshipId}`, attTok);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ ciphertext, keyHint: 'attestor-1 x25519 key v1', state: 'pending', pauseNonce: '1', livePauseNonce: '1', approval: null, relayTx: null, pause: { requestedUntil: until, approvedUntil: null, startedAt: null } });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    const adminView = await rig.get(`/attestor/hardship/${hardshipId}`, adminTok);
    expect(adminView.json().ciphertext).toBe(ciphertext);

    // holders and the issuer: statuses and dates only
    const holderView = await rig.get(`/series/${seriesId}/hardship`, holderTok);
    expect(holderView.statusCode).toBe(200);
    expect(holderView.json()).toEqual({ seriesId, seriesStatus: expect.any(String), paused: false, pausedUntil: null, requests: [{ state: 'pending', requestedUntil: until, approvedUntil: null, requestedAt: expect.any(String), decidedAt: null }] });
    expect(JSON.stringify(holderView.json())).not.toMatch(/ciphertext|keyHint|decisionCode|attestor|signature|approval/);

    // cause S4-PAU: the PAUSE signing request (S4 WP10): Stage 1's MERCES_PAUSE_V1 over the chain's domain, the series key,
    // the live pause nonce and the end, for the request's key; public fields only, no display text. An end after the
    // requested one, beyond u64, or one the chain would refuse is nothing to sign
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${until + DAY}`, attTok)).statusCode).toBe(422);
    const u64Plus = await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${(1n << 64n).toString()}`, attTok);
    expect([u64Plus.statusCode, u64Plus.json().detail]).toEqual([422, { stage1: 'AmountOutOfRange' }]);
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${await h.sim.now()}`, attTok)).json().detail).toEqual({ stage1: 'InvalidPauseEnd' });
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=-1`, attTok)).statusCode).toBe(400);
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}&extra=1`, attTok)).statusCode).toBe(400);
    const msg = await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}`, attTok);
    expect(msg.statusCode, msg.body).toBe(200);
    const signing = (await h.sim.info()).signing!;
    const seriesKey = (await h.sim.getSeries(seriesId))!.seriesKey;
    expect(msg.json()).toMatchObject({ kind: 'PAUSE', chain: h.sim.chain, seriesId, seriesKey, domain: signing, signer: att.address, fields: { pauseNonce: '1', pauseEnd: String(approvedUntil) }, validWhile: 'pause nonce 1' });
    expect(msg.json().digest).toBe(pauseDigest({ domain: signing.domain, seriesKey }, { pauseNonce: 1n, pauseEnd: BigInt(approvedUntil) }).digest);
    expect(msg.json()).not.toHaveProperty('display');
    expect(msg.body).not.toContain(ciphertext.slice(0, 24));
    // an admin may read it (it is public data) but never decide (A-M5-3)
    expect((await rig.get(`/attestor/hardship/${hardshipId}/message?pauseEnd=${approvedUntil}`, adminTok)).statusCode).toBe(200);
    // the attestor's device: its own pinned networks and key; it shows what is authorised from the typed fields and warns
    // that the signature cannot be recalled; it refuses a request whose end was changed under the digest
    const request = msg.json() as SigningRequest<'PAUSE'>;
    const pinned = pinNetworks({ [h.sim.chain]: signing }, { allowLocal: true });
    const device = deviceKey(att);
    expect(() => signRequest({ ...request, fields: { ...request.fields, pauseEnd: String(until) } }, device, pinned, { allowLocal: true })).toThrow(SigningError);
    const shown = describeSigningRequest(checkRequest(request, pinned, { allowLocal: true })).join('\n');
    expect(shown).toMatch(/^Pause approval \(MERCES_PAUSE_V1\) at pause nonce 1/);
    expect(shown).toMatch(/cannot be recalled/);
    const sig = signRequest(request, device, pinned, { allowLocal: true });
    device.wipe();
    expect(sig).toEqual({ signer: att.address, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), digest: request.digest });
    const body = { approve: true, pauseEnd: String(approvedUntil), pauseNonce: request.fields.pauseNonce, attestation: sig };

    // decision: not the chosen attestor (another key's account; an admin never decides); the body's shape
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, body, att1Tok)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, body, adminTok)).statusCode).toBe(403);
    for (const bad of [{ approve: true }, { approve: true, until: approvedUntil }, { ...body, pauseEnd: approvedUntil }, { ...body, attestation: { ...sig, signature: 'sim:' + att.address } }, { ...body, extra: 1 }, { approve: false, pauseEnd: '1' }]) {
      expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, bad, attTok)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // the approved end after the requested end; beyond u64
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { ...body, pauseEnd: String(until + DAY) }, attTok)).statusCode).toBe(422);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { ...body, pauseEnd: (1n << 64n).toString() }, attTok)).json().detail).toEqual({ stage1: 'AmountOutOfRange' });
    // the API recovers the signer over the PAUSE message it rebuilds from the chain's reads (never the caller's digest):
    // another key's signature, another signer named, a signature over another end or nonce, a digest that is not this
    // message, a non-canonical signature: 422 InvalidAttestorSignature, nothing recorded
    const refusedSig = async (b: unknown, message: RegExp) => {
      const r = await rig.post(`/attestor/hardship/${hardshipId}/decide`, b, attTok);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().detail).toEqual({ stage1: 'InvalidAttestorSignature' });
      expect(r.json().message).toMatch(message);
    };
    const otherKey = await h.attestPause(seriesId, approvedUntil, h.attestors[1]!);
    await refusedSig({ ...body, attestation: { ...otherKey, signer: att.address } }, /digest|does not recover/);
    await refusedSig({ ...body, attestation: { signer: att.address, signature: otherKey.signature } }, /does not recover/);
    await refusedSig({ ...body, attestation: otherKey }, /signed by this request's attestor key/);
    await refusedSig({ ...body, pauseEnd: String(approvedUntil - DAY) }, /digest/);
    await refusedSig({ ...body, pauseEnd: String(approvedUntil - DAY), attestation: { signer: sig.signer, signature: sig.signature } }, /does not recover/);
    await refusedSig({ ...body, pauseNonce: '0', attestation: { signer: sig.signer, signature: sig.signature } }, /does not recover/);
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const sHigh = (n - BigInt('0x' + sig.signature.slice(66, 130))).toString(16).padStart(64, '0');
    await refusedSig({ ...body, attestation: { signer: sig.signer, signature: sig.signature.slice(0, 66) + sHigh + (sig.signature.slice(130) === '1b' ? '1c' : '1b') } }, /does not recover/);
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 0, requested: true });
    expect((await rig.t.pool.query('select state, approval, relay_tx from hardship_requests where hardship_id = $1', [hardshipId])).rows[0]).toEqual({ state: 'pending', approval: null, relay_tx: null });

    // the chain holds an approval to Stage 1's bounds whoever sends it: anyone may relay a PAUSE signature (cause S4-PAU:
    // approvePause is permissionless; here a backer's wallet), and an approval ending more than a year out is
    // PauseTooLong, one ending now InvalidPauseEnd; both 422 with nothing changed (cause P)
    const chainNow = await h.sim.now();
    for (const [end, name] of [[chainNow + 366 * DAY, 'PauseTooLong'], [chainNow, 'InvalidPauseEnd']] as const) {
      const cmd = await h.pauseApproval(seriesId, end, att);
      const direct = await rig.post('/tx/send', await h.backers[0]!.sign(await h.sim.build(cmd, h.backers[0]!.address)), holderTok);
      expect(direct.statusCode, name).toBe(422);
      expect(direct.json()).toMatchObject({ error: 'ChainInvalidTerms', detail: { stage1: name } });
    }
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 0, requested: true });

    // the attestor's decision: the keeper relays the checked signature (the attestor sends no transaction)
    const decided = await rig.post(`/attestor/hardship/${hardshipId}/decide`, body, attTok, { 'idempotency-key': 'hard-decide-1' });
    expect(decided.statusCode, JSON.stringify(decided.json())).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'approved', approvedUntil, decisionCode: 'approved', pauseNonce: '1', approval: { signer: att.address, signature: sig.signature, digest: sig.digest, pauseNonce: '1', pauseEnd: String(approvedUntil) }, relayTx: expect.any(String) });
    expect(decided.json()).not.toHaveProperty('tx');
    // the same idempotency key replays the stored answer; the signature is not relayed twice
    const replay = await rig.post(`/attestor/hardship/${hardshipId}/decide`, body, attTok, { 'idempotency-key': 'hard-decide-1' });
    expect(replay.json()).toEqual(decided.json());
    const relayed = (await h.sim.readEvents(null, 10_000)).events.filter((e) => e.txId === decided.json().relayTx);
    // cause P: approve_pause is a Stage 1 sync point; this series has reported nothing for more than 90 days after its
    // first period ended, so the formal notice and the lateness release block are recorded with the approval
    expect(relayed.map((e) => e.type)).toEqual(['PauseApproved', 'StatusChanged', 'FormalNoticeDue', 'ReleasesPaused']);
    expect(relayed[0]!.payload).toEqual({ seriesId, attestor: att.address, start: expect.any(Number), until: approvedUntil });
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    // the pause runs from the approval to the approved end, 30 days before the requested one (cause P: the request's end
    // was advisory); the approval left the nonce where it was
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 1, requested: false, requestedUntil: null, current: { end: approvedUntil } });
    expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('1');
    // a second decision is a 409: the request is decided (and the chain would refuse a replay: PauseNotRequested)
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, body, attTok)).statusCode).toBe(409);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: false, decisionCode: 'insufficient-evidence' }, attTok)).statusCode).toBe(409);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Paused');
    const after = await rig.get(`/series/${seriesId}/hardship`, holderTok);
    expect(after.json()).toMatchObject({ seriesStatus: 'Paused', paused: true, pausedUntil: approvedUntil, requests: [{ state: 'approved', approvedUntil }] });
    expect(JSON.stringify(after.json())).not.toMatch(/signature|approval|relay/);
    expect((await rig.get(`/series/${seriesId}/hardship`, issuerTok)).json().requests[0].state).toBe('approved');
    expect((await rig.get('/attestor/queue', attTok)).json().hardship).toEqual([]);
    // the attestor's view keeps the relayed approval (public data once on the chain)
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, attTok)).json()).toMatchObject({ state: 'approved', approval: { signer: att.address, signature: sig.signature }, relayTx: decided.json().relayTx });
    const audit = await rig.t.pool.query('select action, detail from audit_log where target = $1 order by id', [hardshipId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['hardship.approve']);
    expect(audit.rows[0].detail).toMatchObject({ seriesId, until: approvedUntil, signer: att.address, pauseNonce: '1', digest: sig.digest, relayTx: decided.json().relayTx });
    expect(JSON.stringify(audit.rows)).not.toContain(CANARY);
    // notifications carry statuses, never reasons or signatures
    const outbox = await rig.t.pool.query("select payload from outbox where payload->>'hardshipId' = $1 order by id", [hardshipId]);
    expect(outbox.rows.map((r) => r.payload.kind)).toEqual(['hardship.requested', 'hardship.approved']);
    expect(JSON.stringify(outbox.rows)).not.toMatch(/medical|reason|signature|0x[0-9a-f]{130}/);
    // the public activity feed names the request and the approval, never a signature
    expect(JSON.stringify((await rig.t.pool.query("select summary from activity where series_id = $1 and kind like 'Pause%'", [seriesId])).rows)).not.toMatch(/0x[0-9a-f]{130}/);

    const paused = (await h.sim.getSeries(seriesId))!;
    expect(paused.status).toBe('Paused');
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(409); // paused: no new request
  });

  // cause S4-EXT (S4 WP12): the attestor service opens a request naming the caller's key and a co-attestor key of another
  // account (S4 D15), each key signs Stage 1's EXTINGUISH message on its own device, and once both are in the keeper
  // relays Stage 1's extinguish (was: one transaction the first attestor sent with the second co-signing)
  it('extinguishment: two attestor keys of two accounts sign on their devices; the keeper relays Stage 1\'s extinguish; the chain returns unvested treasury to holders', async () => {
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const adminTok = rig.token({ accountId: 'ext-adm', roles: ['admin'], wallets: [] });
    const evidence = e2e(`death certificate ${CANARY}`);
    const open = (b: Record<string, unknown> = {}, tok = attTok, headers?: Record<string, string>) => rig.post('/attestor/extinguish', { seriesId, attestor: a1.address, coAttestor: a2.address, evidenceCiphertext: evidence, ...b }, tok, headers);
    // the same key twice is Stage 1's SameAttestor; an unregistered co-attestor key; a wallet is no key; plaintext evidence;
    // the old body ({attestors}) is refused
    const same = await open({ coAttestor: a1.address });
    expect([same.statusCode, same.json().detail]).toEqual([422, { stage1: 'SameAttestor' }]);
    expect((await open({ coAttestor: SimSigner.attestor('never-registered').address })).statusCode).toBe(422);
    expect((await open({ coAttestor: h.backers[0]!.address })).statusCode).toBe(400); // cause S4-ID: a wallet is no key
    expect((await open({ evidenceCiphertext: 'death certificate attached as plaintext here' })).statusCode).toBe(422);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a2.address], evidenceCiphertext: evidence }, attTok)).statusCode).toBe(400);
    // `attestor` must be the caller's own key: another registered key's account and an admin are refused
    const [third, fourth, fifth] = ['ext-third', 'ext-fourth', 'ext-fifth'].map((l) => SimSigner.attestor(l)) as [SimSigner, SimSigner, SimSigner];
    for (const k of [third, fourth, fifth]) await h.exec(h.admin, { kind: 'registerAttestor', attestor: k.address });
    await rig.sync();
    const thirdTok = await rig.attestorToken('att-third', [third, fourth]);
    expect((await open({}, thirdTok)).statusCode).toBe(403);
    expect((await open({}, adminTok)).statusCode).toBe(403);
    // S4 D15: two keys of one account (409 same-account); a co-attestor key linked to no account (422: nobody could sign)
    const twoKeys = await open({ attestor: third.address, coAttestor: fourth.address }, thirdTok);
    expect([twoKeys.statusCode, twoKeys.json().detail]).toEqual([409, { reason: 'same-account' }]);
    const unlinked = await open({ coAttestor: fifth.address });
    expect([unlinked.statusCode, unlinked.json().detail]).toEqual([422, { reason: 'co-attestor-not-linked' }]);
    expect((await rig.t.pool.query('select 1 from extinguishment_requests where series_id = $1', [seriesId])).rowCount).toBe(0);

    const req = await open({ keyHint: 'attestors shared key v1' }, attTok, { 'idempotency-key': 'ext-1' });
    expect(req.statusCode, JSON.stringify(req.json())).toBe(201);
    const requestId = req.json().requestId as string;
    expect(req.json()).toMatchObject({ state: 'collecting', attestors: [a1.address, a2.address], signers: [], extinguishNonce: null, relayTx: null, relayError: null });
    expect(req.json()).not.toHaveProperty('tx');
    expect((await open({ keyHint: 'attestors shared key v1' }, attTok, { 'idempotency-key': 'ext-1' })).json()).toEqual(req.json());
    // one open request per series
    expect((await open()).statusCode).toBe(409);
    expect((await rig.get('/attestor/queue', att1Tok)).json().extinguishments).toEqual([expect.objectContaining({ requestId, state: 'collecting', signers: [] })]);
    expect((await rig.get(`/attestor/extinguish/${requestId}`, issuerTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/extinguish/${requestId}`, att1Tok)).json()).toMatchObject({ evidenceCiphertext: evidence, seriesStatus: 'Paused', state: 'collecting', liveExtinguishNonce: '0' });

    // the EXTINGUISH signing request for the caller's own named key that has not signed; another account's key (403), a
    // key the request does not name (422), a stranger key's account (403); an admin may read it, never sign
    const msg = await rig.get(`/attestor/extinguish/${requestId}/message`, attTok);
    expect(msg.statusCode, msg.body).toBe(200);
    const signing = (await h.sim.info()).signing!;
    const seriesKey = (await h.sim.getSeries(seriesId))!.seriesKey;
    expect(msg.json()).toMatchObject({ kind: 'EXTINGUISH', chain: h.sim.chain, seriesId, seriesKey, domain: signing, signer: a1.address, fields: { extinguishNonce: '0' }, validWhile: 'extinguish nonce 0' });
    expect(msg.json().digest).toBe(extinguishDigest({ domain: signing.domain, seriesKey }, { extinguishNonce: 0n }).digest);
    expect(msg.body).not.toContain(evidence.slice(0, 24));
    expect((await rig.get(`/attestor/extinguish/${requestId}/message?attestor=${a2.address}`, attTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/extinguish/${requestId}/message?attestor=${third.address}`, attTok)).statusCode).toBe(422);
    expect((await rig.get(`/attestor/extinguish/${requestId}/message`, thirdTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/extinguish/${requestId}/message?attestor=${a2.address}`, adminTok)).json()).toMatchObject({ signer: a2.address });
    // the attestor's device: its own pinned networks and key; it shows what is authorised and warns that the signature
    // cannot be recalled; it refuses a request whose nonce was changed under the digest
    const request = msg.json() as SigningRequest<'EXTINGUISH'>;
    const pinned = pinNetworks({ [h.sim.chain]: signing }, { allowLocal: true });
    const deviceA = deviceKey(a1);
    expect(() => signRequest({ ...request, fields: { extinguishNonce: '1' } }, deviceA, pinned, { allowLocal: true })).toThrow(SigningError);
    const shown = describeSigningRequest(checkRequest(request, pinned, { allowLocal: true })).join('\n');
    expect(shown).toMatch(/^Extinguishment approval \(MERCES_EXTINGUISH_V1\) at extinguish nonce 0/);
    expect(shown).toMatch(/cannot be recalled/);
    const sigA = signRequest(request, deviceA, pinned, { allowLocal: true });
    deviceA.wipe();
    expect(sigA).toEqual({ signer: a1.address, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), digest: request.digest });
    const bodyA = { extinguishNonce: '0', attestation: sigA };
    const sign = (b: unknown, tok: string, headers?: Record<string, string>) => rig.post(`/attestor/extinguish/${requestId}/sign`, b, tok, headers);

    // signing: only the account holding the named key (another account's; an admin never signs); the body's shape
    expect((await sign(bodyA, att1Tok)).statusCode).toBe(403);
    expect((await sign(bodyA, adminTok)).statusCode).toBe(403);
    for (const bad of [{}, { attestation: sigA }, { ...bodyA, extinguishNonce: 0 }, { ...bodyA, attestation: { ...sigA, signature: 'sim:' + a1.address } }, { ...bodyA, extra: 1 }]) {
      expect((await sign(bad, attTok)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // the API recovers the signer over the EXTINGUISH message it rebuilds from the chain's reads (never the caller's
    // digest): another series' signature, the other chain's domain, another nonce, a non-canonical signature: 422
    // InvalidAttestorSignature, nothing stored
    const refusedSig = async (b: unknown, message: RegExp) => {
      const r = await sign(b, attTok);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().detail).toEqual({ stage1: 'InvalidAttestorSignature' });
      expect(r.json().message).toMatch(message);
    };
    const other = (await h.runRaise()).seriesId;
    const otherSeries = await h.attestExtinguish(other, a1);
    await refusedSig({ ...bodyA, attestation: otherSeries }, /digest/);
    await refusedSig({ ...bodyA, attestation: { signer: a1.address, signature: otherSeries.signature } }, /does not recover/);
    const foreign = await a1.attest('EXTINGUISH', (await rig.mon.sim.info()).signing!, seriesKey, { extinguishNonce: '0' });
    await refusedSig({ ...bodyA, attestation: { signer: a1.address, signature: foreign.signature } }, /does not recover/);
    await refusedSig({ extinguishNonce: '1', attestation: { signer: sigA.signer, signature: sigA.signature } }, /does not recover/);
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const sHigh = (n - BigInt('0x' + sigA.signature.slice(66, 130))).toString(16).padStart(64, '0');
    await refusedSig({ ...bodyA, attestation: { signer: sigA.signer, signature: sigA.signature.slice(0, 66) + sHigh + (sigA.signature.slice(130) === '1b' ? '1c' : '1b') } }, /does not recover/);
    // a signature over a nonce the series has not reached is 409 stale-nonce, with the fresh request
    const ahead = await h.attestExtinguish(seriesId, a1, { extinguishNonce: '1' });
    const stale = await sign({ extinguishNonce: '1', attestation: ahead }, attTok);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().detail).toMatchObject({ reason: 'stale-nonce', liveExtinguishNonce: '0', request: { kind: 'EXTINGUISH', signer: a1.address, fields: { extinguishNonce: '0' } } });
    expect((await rig.t.pool.query('select state, signatures, extinguish_nonce from extinguishment_requests where request_id = $1', [requestId])).rows[0]).toEqual({ state: 'collecting', signatures: [], extinguish_nonce: null });

    // a1 signs: stored, still collecting; the response and every read name the signer, never the signature (a bearer
    // authorisation until the chain has it: S4 amendment D2)
    const signedA = await sign(bodyA, attTok);
    expect(signedA.statusCode, signedA.body).toBe(200);
    expect(signedA.json()).toMatchObject({ state: 'collecting', signers: [a1.address], extinguishNonce: '0', relayTx: null });
    const hidden = sigA.signature.slice(2, 42);
    expect(signedA.body).not.toContain(hidden);
    for (const tok of [attTok, att1Tok, adminTok]) expect((await rig.get(`/attestor/extinguish/${requestId}`, tok)).body).not.toContain(hidden);
    expect((await rig.get('/attestor/queue', att1Tok)).json().extinguishments).toEqual([expect.objectContaining({ requestId, signers: [a1.address] })]);
    expect((await rig.get('/attestor/queue', att1Tok)).body).not.toContain(hidden);
    // a1 has signed: no second request for it
    expect((await rig.get(`/attestor/extinguish/${requestId}/message`, attTok)).json().detail).toEqual({ reason: 'already-signed' });
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');

    // a2 signs on its own device: the request is ready, and the keeper relays both signatures at once
    const msgB = (await rig.get(`/attestor/extinguish/${requestId}/message`, att1Tok)).json() as SigningRequest<'EXTINGUISH'>;
    expect(msgB).toMatchObject({ signer: a2.address, fields: { extinguishNonce: '0' } });
    const deviceB = deviceKey(a2);
    const sigB = signRequest(msgB, deviceB, pinned, { allowLocal: true });
    deviceB.wipe();
    const sent = await sign({ extinguishNonce: '0', attestation: sigB }, att1Tok, { 'idempotency-key': 'ext-sign-b' });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({
      state: 'sent', signers: [a1.address, a2.address], extinguishNonce: '0', relayTx: expect.any(String), relayError: null, decisionCode: 'extinguished',
      signatures: [{ signer: a1.address, signature: sigA.signature, digest: sigA.digest }, { signer: a2.address, signature: sigB.signature, digest: sigB.digest }],
    });
    expect(sent.json()).not.toHaveProperty('evidenceCiphertext');
    // the same idempotency key replays the stored answer; the signatures are not relayed twice
    expect((await sign({ extinguishNonce: '0', attestation: sigB }, att1Tok, { 'idempotency-key': 'ext-sign-b' })).json()).toEqual(sent.json());
    const relayed = (await h.sim.readEvents(null, 100_000)).events.filter((e) => e.txId === sent.json().relayTx);
    const ext = relayed.find((e) => e.type === 'SeriesExtinguished')!;
    expect(ext.payload).toMatchObject({ seriesId, attestors: [a1.address, a2.address] });
    // every tranche vested by 2027 (180 days after settlement), so nothing returns to holders: the vested treasury stays
    // drawable by the issuer (G7; was > 0, the whole unreleased treasury)
    expect((ext.payload as { returnedToHolders: string }).returnedToHolders).toBe('0');
    expect(relayed.map((e) => e.type)).not.toContain('PaymentReceived');
    expect((await h.sim.getSeries(seriesId))!.nonces.extinguish).toBe('1');
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Extinguished');
    expect((await rig.get(`/attestor/extinguish/${requestId}`, attTok)).json()).toMatchObject({ state: 'sent', seriesStatus: 'Extinguished', relayTx: sent.json().relayTx, signatures: [{ signer: a1.address }, { signer: a2.address }] });
    expect((await rig.get('/attestor/queue', attTok)).json().extinguishments).toEqual([]);
    // a sent request takes no more signatures; the extinguished series takes no new request (TerminalStatus)
    expect((await sign(bodyA, attTok)).statusCode).toBe(409);
    expect((await open({ evidenceCiphertext: e2e('x'.repeat(40)) })).json().detail).toEqual({ stage1: 'TerminalStatus' });
    // the audit names the keys, the nonce, the digest and the relay, never a signature or the evidence
    const audit = await rig.t.pool.query('select action, detail from audit_log where target = $1 order by id', [requestId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['extinguishment.request', 'extinguishment.sign', 'extinguishment.sign', 'extinguishment.relay']);
    expect(audit.rows[0].detail).toMatchObject({ seriesId, attestors: [a1.address, a2.address] });
    expect(audit.rows[3].detail).toMatchObject({ seriesId, attestors: [a1.address, a2.address], extinguishNonce: '0', digest: sigA.digest, relayTx: sent.json().relayTx });
    expect(JSON.stringify(audit.rows)).not.toMatch(new RegExp(`${CANARY}|${hidden}|${sigB.signature.slice(2, 42)}`));
    // the activity feed and the notifications never carry a signature
    expect(JSON.stringify((await rig.t.pool.query('select summary from activity where series_id = $1', [seriesId])).rows)).not.toMatch(/0x[0-9a-f]{130}/);
    expect(JSON.stringify((await rig.t.pool.query('select payload from outbox')).rows)).not.toMatch(/0x[0-9a-f]{130}/);
  });

  // cause S4-EXT (S4 WP12): what kills a collected EXTINGUISH signature, and what a refused relay leaves
  it('extinguishment: a key revoked after it signed kills its signature, a refused relay stays ready with its code, two keys of one account never sign, another extinguishment withdraws an open request', async () => {
    const s2 = (await h.runRaise()).seriesId;
    await rig.sync();
    const [k5, k6, k7] = ['ext-k5', 'ext-k6', 'ext-k7'].map((l) => SimSigner.attestor(l)) as [SimSigner, SimSigner, SimSigner];
    for (const k of [k5, k6, k7]) await h.exec(h.admin, { kind: 'registerAttestor', attestor: k.address });
    await rig.sync();
    const [t5, t6, t7] = [await rig.attestorToken('att-k5', [k5]), await rig.attestorToken('att-k6', [k6]), await rig.attestorToken('att-k7', [k7])];
    const openFor = async (sid: string, a: SimSigner, b: SimSigner, tok: string) => {
      const r = await rig.post('/attestor/extinguish', { seriesId: sid, attestor: a.address, coAttestor: b.address, evidenceCiphertext: e2e('evidence of permanent disability') }, tok);
      expect(r.statusCode, r.body).toBe(201);
      return r.json().requestId as string;
    };
    const row = async (id: string) => (await rig.t.pool.query('select state, decision_code, extinguish_nonce::text, relay_error, relay_tx, signatures from extinguishment_requests where request_id = $1', [id])).rows[0];
    const id = await openFor(s2, k5, k6, t5);
    expect((await rig.signExtinguish(id, k5, t5)).json()).toMatchObject({ state: 'collecting', signers: [k5.address] });
    // k5 is revoked after it signed: when k6's signature makes the request ready, the relay's own check finds k5's dead,
    // drops it and the request collects again (409 attestor-key-inactive, Stage 1's InvalidAttestorSignature)
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: k5.address });
    const dead = await rig.signExtinguish(id, k6, t6);
    expect(dead.statusCode, dead.body).toBe(409);
    expect(dead.json().detail).toEqual({ reason: 'attestor-key-inactive', stage1: 'InvalidAttestorSignature', keys: [k5.address] });
    expect(await row(id)).toMatchObject({ state: 'collecting', decision_code: 'attestor-key-inactive', extinguish_nonce: '0', relay_error: null, relay_tx: null, signatures: [expect.objectContaining({ signer: k6.address })] });
    expect((await h.sim.getSeries(s2))!.status).not.toBe('Extinguished');
    // registered again, k5 signs again; the chain refuses the relay (here, once, by a stubbed refusal): the request stays
    // ready with the code and the error comes back with Stage 1's name; posting the stored signature again retries
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: k5.address });
    await rig.sync();
    const stub = vi.spyOn(h.sim, 'submit').mockRejectedValueOnce(new ChainError('WrongStatus', 'the series is terminal', { stage1: 'TerminalStatus' }));
    const refused = await rig.signExtinguish(id, k5, t5);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'ChainWrongStatus', detail: { stage1: 'TerminalStatus' } });
    expect(stub).toHaveBeenCalledTimes(1);
    stub.mockRestore();
    expect(await row(id)).toMatchObject({ state: 'ready', relay_error: 'TerminalStatus', relay_tx: null });
    expect((await rig.get(`/attestor/extinguish/${id}`, t6)).json()).toMatchObject({ state: 'ready', relayError: 'TerminalStatus', signers: [k5.address, k6.address] });
    expect((await rig.get(`/attestor/extinguish/${id}`, t6)).json()).not.toHaveProperty('signatures');
    expect((await rig.get(`/attestor/extinguish/${id}/message`, t6)).statusCode).toBe(409); // ready: nothing more to sign
    const retried = await rig.signExtinguish(id, k5, t5); // the message route is closed while ready: post the stored signature
    expect(retried.statusCode).toBe(409);
    const stored = (await row(id)).signatures as { signer: string; signature: string; digest: string }[];
    const again = await rig.post(`/attestor/extinguish/${id}/sign`, { extinguishNonce: '0', attestation: stored.find((x) => x.signer === k5.address)! }, t5);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ state: 'sent', relayError: null, relayTx: expect.any(String) });
    expect((await h.sim.getSeries(s2))!.status).toBe('Extinguished');

    // S4 D15 is read live: a key relinked to the other named key's account cannot sign (409 same-account)
    const s3 = (await h.runRaise()).seriesId;
    await rig.sync();
    const id3 = await openFor(s3, k6, k7, t6);
    await rig.t.pool.query("update account_signer_keys set account_id = 'att-k6' where address = $1", [k7.address]);
    const both = await rig.signExtinguish(id3, k6, t6);
    expect([both.statusCode, both.json().detail]).toEqual([409, { reason: 'same-account' }]);
    await rig.t.pool.query("update account_signer_keys set account_id = 'att-k7' where address = $1", [k7.address]);
    expect((await rig.signExtinguish(id3, k6, t6)).json()).toMatchObject({ state: 'collecting', signers: [k6.address] });
    // a key an open request names cannot be unlinked (its account is one of the two)
    const unlink = await rig.del(`/me/signer-keys/${k7.address}`, t7);
    expect([unlink.statusCode, unlink.json().detail]).toEqual([409, { reason: 'open-work', openWork: { hardship: 0, tier3: 0, annual: 0, extinguishments: 1, amendments: 0 } }]);
    // another extinguishment of the series lands (two other keys' signatures relayed directly): the open request can no
    // longer be completed, and the indexer withdraws it, its dead signature dropped
    await h.sim.submit(await h.extinguishment(s3), 'keeper');
    await rig.sync();
    expect(await row(id3)).toMatchObject({ state: 'withdrawn', decision_code: 'series-extinguished', extinguish_nonce: null, signatures: [] });
    expect((await rig.get('/attestor/queue', t7)).json().extinguishments).toEqual([]);
  });

  // S1 review: decide checked only the requested end and "in the future", so it recorded 'approved' (and notified it) for a
  // pause Stage 1's approve_pause refuses (more than a year, more than two years in total, 16 pauses); the request then
  // left the queue and a second decision was a 409. It also refused, with a 409, a request the chain would approve when an
  // earlier pause had ended but was not announced yet. Runs after the extinguishment test: it moves the clock two years.
  it('hardship: a decision is checked against Stage 1\'s approve_pause bounds before it is recorded; a refusal leaves the request pending', async () => {
    const att = h.attestors[0]!;
    const s = (await h.runRaise()).seriesId;
    await rig.sync();
    const open = async (until: number): Promise<string> => {
      const r = await rig.post(`/series/${s}/hardship`, { until, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok);
      expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
      const sent = await rig.post('/tx/send', await h.issuer.sign(r.json().tx as UnsignedTx), issuerTok);
      expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
      return r.json().hardshipId as string;
    };
    // cause S4-PAU: an approval is the key's PAUSE signature over the live nonce, relayed by the keeper
    const approve = async (id: string, until: number) => {
      const d = await rig.post(`/attestor/hardship/${id}/decide`, await harnessDecision(s, until, att), attTok);
      expect(d.statusCode, JSON.stringify(d.json())).toBe(200);
      expect(d.json()).toMatchObject({ state: 'approved', approvedUntil: until });
      const relayed = (await h.sim.readEvents(null, 100_000)).events.filter((e) => e.txId === d.json().relayTx);
      expect(relayed[0]!.type).toBe('PauseApproved');
    };
    /** a refused decision: Stage 1's name, a message without the date, and nothing recorded, notified or audited */
    const refused = async (id: string, until: number, stage1: string) => {
      const r = await rig.post(`/attestor/hardship/${id}/decide`, await harnessDecision(s, until, att), attTok);
      expect(r.statusCode, JSON.stringify(r.json())).toBe(422);
      expect(r.json()).toMatchObject({ error: 'Unprocessable', detail: { stage1 } });
      expect(Object.keys(r.json().detail)).toEqual(['stage1']);
      const pending = await rig.t.pool.query('select state, approved_until, decision_code, decided_at, approval, relay_tx from hardship_requests where hardship_id = $1', [id]);
      expect(pending.rows[0]).toEqual({ state: 'pending', approved_until: null, decision_code: null, decided_at: null, approval: null, relay_tx: null });
      // the signing request is refused alike: nothing to sign for an end the chain refuses
      expect((await rig.get(`/attestor/hardship/${id}/message?pauseEnd=${until}`, attTok)).json().detail).toEqual({ stage1 });
      expect((await rig.get('/attestor/queue', attTok)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).toContain(id);
      expect((await rig.t.pool.query("select payload->>'kind' as kind from outbox where payload->>'hardshipId' = $1 order by id", [id])).rows.map((x) => x.kind)).toEqual(['hardship.requested']);
      expect((await rig.t.pool.query('select 1 from audit_log where target = $1', [id])).rowCount).toBe(0);
      return r.json().message as string;
    };

    // a requested end more than a year out is advisory and accepted; approving it as requested is PauseTooLong
    let now = await h.sim.now();
    const first = await open(now + 400 * DAY);
    const msg = await refused(first, now + 400 * DAY, 'PauseTooLong');
    expect(msg).toBe('a pause may last at most 365 days, and the series\' pauses 730 days in total');
    expect(msg).not.toContain(String(now + 400 * DAY));
    await refused(first, now + 365 * DAY + 1, 'PauseTooLong');
    await refused(first, now, 'InvalidPauseEnd');
    expect((await rig.get(`/series/${s}/hardship`, issuerTok)).json()).toMatchObject({ paused: false, requests: [{ state: 'pending', approvedUntil: null, decidedAt: null }] });
    expect((await h.sim.getSeries(s))!.pauses).toMatchObject({ count: 0, requested: true });
    // the attestor decides again, at the bound, and the chain accepts it
    await approve(first, now + 365 * DAY);
    expect((await h.sim.getSeries(s))!.status).toBe('Paused');

    // the first pause ends by itself; its PauseEnded is not announced yet (no crank), and the chain approves a new one
    await h.sim.advanceTime(365 * DAY);
    now = await h.sim.now();
    expect((await h.sim.getSeries(s))!.pause).toMatchObject({ startedAt: expect.any(Number) });
    const view = await rig.get(`/attestor/hardship/${first}`, attTok);
    expect(view.json().pauses).toMatchObject({ count: 1, pausedTotalSeconds: 365 * DAY, current: null });
    const second = await open(now + 400 * DAY);
    await approve(second, now + 300 * DAY);

    // 665 of the 730 days are used: a 66-day pause is within a year but over the cumulative limit
    await h.sim.advanceTime(300 * DAY);
    now = await h.sim.now();
    const third = await open(now + 100 * DAY);
    await refused(third, now + 66 * DAY, 'PauseTooLong');
    await approve(third, now + 65 * DAY);

    // nothing is left: a new request is refused before the issuer sends it, with nothing stored or notified
    await h.sim.advanceTime(65 * DAY);
    now = await h.sim.now();
    const rows = (await rig.t.pool.query('select count(*)::int as n from hardship_requests where series_id = $1', [s])).rows[0].n;
    const exhausted = await rig.post(`/series/${s}/hardship`, { until: now + 30 * DAY, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok);
    expect(exhausted.statusCode, JSON.stringify(exhausted.json())).toBe(422);
    expect(exhausted.json()).toMatchObject({ detail: { stage1: 'PauseTooLong' } });
    expect((await rig.t.pool.query('select count(*)::int as n from hardship_requests where series_id = $1', [s])).rows[0].n).toBe(rows);
    expect((await h.sim.getSeries(s))!.pauses).toMatchObject({ count: 3, pausedTotalSeconds: 730 * DAY, requested: false });
    expect((await rig.get(`/series/${s}/hardship`, issuerTok)).json().requests.map((x: { state: string }) => x.state)).toEqual(['approved', 'approved', 'approved']);
  });

  // cause S4-PAU, S4-WD (S4 WP10): the PAUSE signature binds the series' live pause nonce, which a re-request or the
  // issuer's withdrawal moves; the attestor service reads it again before the keeper relays, and the indexer follows the
  // onchain request. A chain refusal at the relay leaves the request pending, with nothing stored.
  it('hardship: a re-request makes a collected signature stale (409 with a fresh request); the issuer withdraws; a refused relay leaves the request pending', async () => {
    const att = h.attestors[0]!;
    const s = (await h.runRaise()).seriesId;
    await rig.sync();
    const pinned = pinNetworks({ [h.sim.chain]: (await h.sim.info()).signing! }, { allowLocal: true });
    /** the attestor tool signs the API's PAUSE request; the decision body as the tool's output posts */
    const signed = async (id: string, end: number) => {
      const msg = await rig.get(`/attestor/hardship/${id}/message?pauseEnd=${end}`, attTok);
      expect(msg.statusCode, msg.body).toBe(200);
      const request = msg.json() as SigningRequest<'PAUSE'>;
      const device = deviceKey(att);
      const sig = signRequest(request, device, pinned, { allowLocal: true });
      device.wipe();
      return { approve: true, pauseEnd: String(end), pauseNonce: request.fields.pauseNonce, attestation: sig };
    };
    const row = async (id: string) => (await rig.t.pool.query('select state, decision_code, pause_nonce::text, approval, relay_tx from hardship_requests where hardship_id = $1', [id])).rows[0];
    let now = await h.sim.now();
    const open = await rig.post(`/series/${s}/hardship`, { until: now + 90 * DAY, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok);
    expect(open.statusCode, open.body).toBe(201);
    const a = open.json().hardshipId as string;
    expect((await rig.post('/tx/send', await h.issuer.sign(open.json().tx as UnsignedTx), issuerTok)).statusCode).toBe(200);
    await rig.sync();
    expect(await row(a)).toMatchObject({ state: 'pending', pause_nonce: '1' });
    const end = now + 30 * DAY;
    const atOne = await signed(a, end);
    expect(atOne.pauseNonce).toBe('1');
    // the issuer requests again onchain (nonce 1 → 2): the collected signature is dead on the chain; the decision reads the
    // nonce again and answers 409 stale-nonce with the fresh signing request, nothing recorded or relayed
    await h.exec(h.issuer, { kind: 'requestPause', seriesId: s, until: now + 60 * DAY });
    await rig.sync();
    expect(await row(a)).toMatchObject({ state: 'pending', pause_nonce: '2' });
    const stale = await rig.post(`/attestor/hardship/${a}/decide`, atOne, attTok);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().detail).toMatchObject({ reason: 'stale-nonce', livePauseNonce: '2', request: { kind: 'PAUSE', signer: att.address, fields: { pauseNonce: '2', pauseEnd: String(end) } } });
    expect(stale.json().detail.request.digest).not.toBe(atOne.attestation.digest);
    // claiming the live nonce for the old signature does not help: it no longer recovers to the key
    const lied = await rig.post(`/attestor/hardship/${a}/decide`, { ...atOne, pauseNonce: '2', attestation: { signer: att.address, signature: atOne.attestation.signature } }, attTok);
    expect([lied.statusCode, lied.json().detail]).toEqual([422, { stage1: 'InvalidAttestorSignature' }]);
    expect(await row(a)).toMatchObject({ state: 'pending', approval: null, relay_tx: null });
    expect((await h.sim.getSeries(s))!.pauses).toMatchObject({ count: 0, requested: true });

    // cause S4-WD: the issuer withdraws its onchain request (build-withdraw, the issuer's only)
    expect((await rig.post(`/series/${s}/hardship/build-withdraw`, {}, holderTok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${s}/hardship/build-withdraw`, {}, attTok)).statusCode).toBe(403);
    const wd = await rig.post(`/series/${s}/hardship/build-withdraw`, {}, issuerTok);
    expect(wd.statusCode, wd.body).toBe(200);
    expect(wd.json()).toMatchObject({ seriesId: s, pauseNonce: '2', tx: { command: { kind: 'withdrawPauseRequest', seriesId: s }, signer: h.issuer.address } });
    const sentWd = await rig.post('/tx/send', await h.issuer.sign(wd.json().tx as UnsignedTx), issuerTok);
    expect(sentWd.statusCode, sentWd.body).toBe(200);
    expect(sentWd.json().events).toEqual([{ type: 'PauseRequestWithdrawn', seq: expect.any(Number), payload: { seriesId: s, nonce: '3' } }]);
    // before the indexer catches up the chain already says no request: nothing to sign, nothing to approve
    expect((await rig.get(`/attestor/hardship/${a}/message?pauseEnd=${end}`, attTok)).json().detail).toEqual({ stage1: 'PauseNotRequested' });
    expect((await rig.post(`/attestor/hardship/${a}/decide`, atOne, attTok)).json().detail).toEqual({ stage1: 'PauseNotRequested' });
    expect((await rig.post(`/series/${s}/hardship/build-withdraw`, {}, issuerTok)).json().detail).toEqual({ stage1: 'PauseNotRequested' });
    await rig.sync();
    expect(await row(a)).toMatchObject({ state: 'withdrawn', decision_code: 'withdrawn', pause_nonce: '2', approval: null });
    expect((await rig.get('/attestor/queue', attTok)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).not.toContain(a);
    expect((await rig.post(`/attestor/hardship/${a}/decide`, { approve: false }, attTok)).statusCode).toBe(409);
    expect((await rig.get(`/series/${s}/hardship`, holderTok)).json().requests).toEqual([expect.objectContaining({ state: 'withdrawn', approvedUntil: null })]);

    // a new request; a replay of the older withdrawal never withdraws it (its request's nonce is above the event's)
    now = await h.sim.now();
    const again = await rig.post(`/series/${s}/hardship`, { until: now + 90 * DAY, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok);
    expect(again.statusCode, again.body).toBe(201);
    const b = again.json().hardshipId as string;
    expect((await rig.post('/tx/send', await h.issuer.sign(again.json().tx as UnsignedTx), issuerTok)).statusCode).toBe(200);
    await rig.sync();
    expect(await row(b)).toMatchObject({ state: 'pending', pause_nonce: '4' });
    const withdrawn = (await h.sim.readEvents(null, 100_000)).events.filter((e) => e.type === 'PauseRequestWithdrawn' && (e.payload as { seriesId: string }).seriesId === s);
    const c = await rig.t.pool.connect();
    try {
      for (const e of withdrawn) await project(c, e);
    } finally {
      c.release();
    }
    expect(await row(b)).toMatchObject({ state: 'pending', pause_nonce: '4' });

    // the relay loses a race onchain: another sender's copy of the same approval lands first, so the chain refuses the
    // keeper's (PauseNotRequested, 422 with Stage 1's name); the request stays pending with nothing stored (A-REV-23)
    const body = await signed(b, now + 30 * DAY);
    const port = h.sim;
    const submit = port.submit.bind(port);
    port.submit = async (cmd, role) => {
      if (cmd.kind === 'approvePause') await submit(cmd, role);
      return submit(cmd, role);
    };
    let lost;
    try {
      lost = await rig.post(`/attestor/hardship/${b}/decide`, body, attTok);
    } finally {
      port.submit = submit;
    }
    expect(lost.statusCode, lost.body).toBe(422);
    expect(lost.json()).toMatchObject({ error: 'ChainWrongStatus', detail: { stage1: 'PauseNotRequested' } });
    expect(await row(b)).toMatchObject({ state: 'pending', approval: null, relay_tx: null });
    expect((await rig.t.pool.query("select count(*)::int as n from audit_log where target = $1 and action = 'hardship.approve'", [b])).rows[0].n).toBe(0);
    expect((await h.sim.getSeries(s))!.status).toBe('Paused');
    // the attestor closes it with a code (no signature needed)
    const closed = await rig.post(`/attestor/hardship/${b}/decide`, { approve: false, decisionCode: 'approved-elsewhere' }, attTok);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ state: 'rejected', decisionCode: 'approved-elsewhere', relayTx: null });
    expect(closed.json()).not.toHaveProperty('approval');
  });

  it('privacy: the attestor tables and logs hold ciphertext and amounts only — never the plaintext or the canary', async () => {
    for (const table of ['hardship_requests', 'tier3_cases', 'tier3_annual', 'extinguishment_requests', 'fx_fallback_requests', 'audit_log', 'outbox', 'idempotency_keys']) {
      const rows = await rig.t.pool.query(`select row_to_json(t)::text as j from ${table} t`);
      expect(rows.rows.length, table).toBeGreaterThan(0);
      for (const r of rows.rows) {
        expect(r.j, table).not.toContain(CANARY);
        expect(r.j, table).not.toMatch(/medical leave|discharge summary|death certificate|Schedule C gross/);
      }
    }
  });
});

// S1 review: the guard read bare hex as base64 only, so hex-encoded plaintext (an opening, documents, a hardship reason)
// passed and was stored. These run without a database.
describe('end-to-end ciphertext guards', () => {
  const refused = (f: () => void): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const plainDocs = '1040 Schedule C gross receipts 7317317317';
  const opening = JSON.stringify({ version: 'merces/tier3-opening/v1', seriesId: 'solana:s', periodId: '2026Q3', incomeYtd: '8484848484', incomeSalt: '123', priorIncomeYtd: '8282828282', priorSalt: '456', priorIncomeCommitment: '0x' + '11'.repeat(32), incomeCommitment: '0x' + '22'.repeat(32) });

  it('assertOpaqueCiphertext refuses plaintext in hex (bare, upper case, 0x), base64 and base64url, and encoded document files', () => {
    for (const plain of [plainDocs, opening, 'medical diagnosis, salary cut']) {
      const b = Buffer.from(plain);
      for (const v of [b.toString('hex'), b.toString('hex').toUpperCase(), '0x' + b.toString('hex'), b.toString('base64'), b.toString('base64url')]) {
        const m = refused(() => assertOpaqueCiphertext(v, 'documentsCiphertext'));
        expect(m, v.slice(0, 40)).toMatch(/^documentsCiphertext /);
        expect(m).not.toMatch(/7317317317|8484848484/);
      }
    }
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(200)]);
    expect(refused(() => assertOpaqueCiphertext(pdf.toString('base64'), 'documentsCiphertext'))).toMatch(/only encoded/);
    // real ciphertext passes in each encoding the contract names
    for (let i = 0; i < 50; i++) {
      const ct = Buffer.from(e2e(plainDocs), 'base64');
      for (const v of [ct.toString('base64'), ct.toString('base64url'), ct.toString('hex'), '0x' + ct.toString('hex')]) expect(refused(() => assertOpaqueCiphertext(v, 'documentsCiphertext')), v).toBeNull();
    }
  });

  it('assertTier3OpeningEnvelope takes a merces-e2e v1 envelope only', () => {
    const b = Buffer.from(opening);
    for (const v of [opening, b.toString('hex'), b.toString('hex').toUpperCase(), '0x' + b.toString('hex'), b.toString('base64'), b.toString('base64url'), e2e(opening)]) {
      const m = refused(() => assertTier3OpeningEnvelope(v));
      expect(m, v.slice(0, 40)).toMatch(/^openingCiphertext must be a merces-e2e v1 envelope sealed for the attestor: /);
      expect(m).not.toMatch(/8484848484|8282828282/);
    }
    expect(refused(() => assertTier3OpeningEnvelope(sealTier3Opening(JSON.parse(opening), ATTESTOR_E2E.publicKey)))).toBeNull();
  });
});

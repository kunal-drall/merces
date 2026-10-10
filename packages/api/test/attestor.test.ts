import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { E2E_TIER3_OPENING, ZERO_INCOME_COMMITMENT, attestationMessage, fxAttestationMessage, type UnsignedTx } from '@merces/domain';
import { WAD, parsePeriod, periodOf, ratePerUnit, wadFromDecimal } from '@merces/math';
import { assembleOnDevice, checkTier3Opening, generateE2eKeyPair, openTier3Opening, sealE2e, sealTier3Opening } from '@merces/poi-device';
import { assertOpaqueCiphertext, assertTier3OpeningEnvelope } from '@merces/services';
import type { SimHarness } from '@merces/simulator';
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
 *  - G7: an extinguishment returns only the unvested proceeds.
 */

/** The canary value the privacy suite scans the database and logs for (docs/SERVICES.md). */
const CANARY = '7317317317';

/** Stand-in for the client's end-to-end encryption: AES-256-GCM under a throwaway key the server never sees. */
function e2e(plain: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
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
    attTok = rig.token({ accountId: 'att-0', wallets: [{ chain: 'solana', address: h.attestors[0]!.address }], roles: ['attestor'] });
    att1Tok = rig.token({ accountId: 'att-1', wallets: [{ chain: 'solana', address: h.attestors[1]!.address }], roles: ['attestor'] });
    holderTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    strangerTok = rig.token({ accountId: 'x', wallets: [{ chain: 'solana', address: 'nobody' }], roles: ['backer'] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('access matrix: the queue, profile and attestor views are attestor-only; the profile shows onchain registration', async () => {
    expect((await rig.get('/attestor/queue')).statusCode).toBe(401);
    expect((await rig.get('/attestor/queue', issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/queue', holderTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/me', issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/fx-requests', holderTok)).statusCode).toBe(403);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address], evidenceCiphertext: e2e('x') }, issuerTok)).statusCode).toBe(403);
    // only the issuer opens hardship and tier-3 requests
    expect((await rig.post(`/series/${seriesId}/hardship`, { until: 1, attestor: h.attestors[0]!.address, ciphertext: e2e('x') }, holderTok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/tier3/2026Q1`, { attestor: h.attestors[0]!.address, documentsCiphertext: e2e('x'), estimatePaymentStable: '1' }, attTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/tier3`, holderTok)).statusCode).toBe(403);
    // the holder view of hardship is for holders and the issuer, not strangers
    expect((await rig.get(`/series/${seriesId}/hardship`, strangerTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/hardship`, holderTok)).statusCode).toBe(200);

    const me = await rig.get('/attestor/me', attTok);
    expect(me.statusCode).toBe(200);
    expect(me.json().wallets).toEqual([{ chain: 'solana', address: h.attestors[0]!.address, registeredOnchain: true }]);
    expect(me.json().openWork).toEqual({ hardship: 0, tier3: 0, tier3Annual: 0, fxRequests: 0, amendments: 0, extinguishments: 0 });
    // a token claiming the attestor role for a wallet the chain has not registered gets no attestor routes at all
    const unregistered = rig.token({ accountId: 'att-x', wallets: [{ chain: 'solana', address: h.backers[4]!.address }], roles: ['attestor'] });
    expect((await rig.get('/attestor/me', unregistered)).statusCode).toBe(403);
    const q = await rig.get('/attestor/queue', attTok);
    expect(q.statusCode).toBe(200);
    expect(q.json()).toEqual({ hardship: [], tier3: [], tier3Annual: [], fxRequests: [], amendments: [], extinguishments: [] });
  });

  it('tier 3: case → client-side prefill spec → attestor signs → issuer assembles via E5 with the attestor co-signing → annual true-up', async () => {
    const att = h.attestors[0]!;
    const periodId = '2026Q1';
    // the quarter has not ended yet
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: e2e(DOCS_PLAIN), estimatePaymentStable: USDC(1800).toString() }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(parsePeriod(periodId).end + DAY);
    // plaintext documents are refused
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: JSON.stringify({ documents: ['1040'], grossReceipts: CANARY }), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: att.address, openingCiphertext: sealedStub(), documentsCiphertext: Buffer.from(JSON.stringify({ grossReceipts: CANARY, note: 'x' })).toString('base64'), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
    // unknown attestor
    expect((await rig.post(`/series/${seriesId}/tier3/${periodId}`, { attestor: h.backers[0]!.address, openingCiphertext: sealedStub(), documentsCiphertext: e2e(DOCS_PLAIN), estimatePaymentStable: '1' }, issuerTok)).statusCode).toBe(422);
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

    // attestor device: open the envelope with its private key, check the opening against the documents, sign
    expect(openTier3Opening(view.json().openingCiphertext, ATTESTOR_E2E.privateKey)).toEqual(opening);
    const c = { seriesId, periodId, priorIncomeCommitment: dev.assembled.priorIncomeCommitment, incomeCommitment: dev.assembled.incomeCommitment };
    // 2026Q1 is the series' first report and a year start: the prior the attestor signs over is ZERO (cause R)
    expect(c.priorIncomeCommitment).toBe(ZERO_INCOME_COMMITMENT);
    expect(checkTier3Opening(opening, { ...c, documentedYtd: USDC(80_000) })).toEqual({ ok: true });
    const signature = await att.signMessage(attestationMessage({ ...c, tier: 3, liquidityEvent: false }));
    const signBody = { priorIncomeCommitment: c.priorIncomeCommitment, incomeCommitment: c.incomeCommitment, proof: dev.assembled.proof, attestation: { liquidityEvent: false, signature } };
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, att1Tok)).statusCode).toBe(403);
    // the sign body carries commitments, the proof and the attestation only: an opening field is refused (strict)
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, { ...signBody, incomeYtd: opening.incomeYtd }, attTok)).statusCode).toBe(400);
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, { ...signBody, attestation: { liquidityEvent: true, signature } }, attTok)).statusCode).toBe(422); // signed another flag
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, { ...signBody, incomeCommitment: c.priorIncomeCommitment }, attTok)).statusCode).toBe(422); // proof over other commitments
    const signed = await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, attTok, { 'idempotency-key': 't3-sign-q1' });
    expect(signed.statusCode, JSON.stringify(signed.json())).toBe(200);
    expect(signed.json()).toMatchObject({ state: 'signed', attestedPaymentStable: USDC(2000).toString(), incomeCommitment: c.incomeCommitment, priorIncomeCommitment: c.priorIncomeCommitment });
    expect((await rig.post(`/attestor/tier3/${caseId}/sign`, signBody, attTok)).statusCode).toBe(409);
    expect((await rig.get('/attestor/queue', attTok)).json().tier3).toEqual([]);
    const forIssuer = await rig.get(`/series/${seriesId}/tier3`, issuerTok);
    expect(forIssuer.json().cases[0]).toMatchObject({ caseId, state: 'signed', attestedPaymentStable: USDC(2000).toString() });
    expect(JSON.stringify(forIssuer.json())).not.toContain(docs.slice(0, 32));
    expect(JSON.stringify(forIssuer.json())).not.toContain(openingCiphertext.slice(0, 32));

    // the issuer assembles the tier-3 report through E5 with the attestor as co-signer, then both sign and the issuer sends
    const rep = await rig.post(`/series/${seriesId}/reports`, { ...dev.assembled, attestor: att.address }, issuerTok, { 'idempotency-key': 't3-rep-q1' });
    expect(rep.statusCode, JSON.stringify(rep.json())).toBe(201);
    expect(rep.json()).toMatchObject({ tier: 3, verifiedOffchain: true, paymentStable: USDC(2000).toString() });
    const reportId = rep.json().reportId as string;
    const tx = rep.json().tx as UnsignedTx;
    expect(tx.command).toMatchObject({ kind: 'submitReport', tier: 3, attestor: att.address });
    expect(tx.coSigners).toEqual([att.address]);
    const sent = await rig.post('/tx/send', await att.coSign(await h.issuer.sign(tx)), issuerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const accepted = sent.json().events.find((e: { type: string }) => e.type === 'ReportAccepted');
    // 10% × (80,000 − 60,000) = 2,000 due, no accrual at the report (cause R), chained from ZERO
    expect(accepted.payload).toMatchObject({ tier: 3, paymentDue: USDC(2000).toString(), accrual: '0', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: c.incomeCommitment });
    expect((await rig.post(`/reports/${reportId}/submitted`, { txId: sent.json().txId }, issuerTok)).json().state).toBe('accepted');
    const pay = await rig.post(`/reports/${reportId}/build-payin`, {}, issuerTok);
    expect(pay.json().amount).toBe(USDC(2000).toString());
    expect((await rig.post('/tx/send', await h.issuer.sign(pay.json().tx), issuerTok)).statusCode).toBe(200);
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

  it('FX fallback: the keeper opens a request, an attestor signs the rate client-side, the issuer reads it for assembly', async () => {
    const att = h.attestors[1]!;
    const eur = await h.runRaise({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'EUR', indexingRule: 'cpi-annual', termsSalt: BigInt('0x' + '55'.repeat(31)) }, terms: { reportingCurrency: 'EUR' } });
    const q = periodOf(await h.sim.now());
    await h.sim.setTime(q.end + DAY);
    await rig.sync();
    // the rate keeper (E8) flags the quarter and opens the request (keepers' openFallback); no snapshots → coverage
    const quarter = await h.sim.getQuarterRate('EUR/USD', q.id);
    expect(quarter?.needsFallback).toBe(true);
    await rig.t.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5)', ['fxreq_test1', 'solana', 'EUR/USD', q.id, 'coverage']);
    // a monad request is not on a solana-only attestor's list
    await rig.t.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5)', ['fxreq_test2', 'monad', 'EUR/USD', q.id, 'coverage']);
    const list = await rig.get('/attestor/fx-requests', att1Tok);
    expect(list.json().requests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test1']);
    expect((await rig.get('/attestor/queue', att1Tok)).json().fxRequests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test1']);
    const monadAtt = rig.token({ accountId: 'att-m', wallets: [{ chain: 'monad', address: rig.mon.attestors[0]!.address }], roles: ['attestor'] });
    expect((await rig.get('/attestor/fx-requests', monadAtt)).json().requests.map((r: { requestId: string }) => r.requestId)).toEqual(['fxreq_test2']);
    // before any signature the issuer sees the open request and no rate
    expect((await rig.get(`/series/${eur.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ pair: 'EUR/USD', basis: 'attestor', state: 'open', attestorRate: null });
    expect((await rig.get(`/series/${seriesId}/reporting/fx-fallback/${q.id}`, issuerTok)).json()).toMatchObject({ basis: 'unity', attestorRate: null });

    const rateWad = wadFromDecimal('1.08').toString();
    const message = fxAttestationMessage({ pair: 'EUR/USD', periodId: q.id, rateWad });
    const signature = await att.signMessage(message);
    // a wallet not linked to the session, a bad signature and a free-text source note are refused
    expect((await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, attestorWallet: h.attestors[0]!.address, sourceNote: 'ecb-reference-rate', signature }, att1Tok)).statusCode).toBe(403);
    expect((await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, attestorWallet: att.address, sourceNote: 'ecb-reference-rate', signature: 'sim:deadbeef' }, att1Tok)).statusCode).toBe(422);
    expect((await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad: '1090000000000000000', attestorWallet: att.address, sourceNote: 'ecb-reference-rate', signature }, att1Tok)).statusCode).toBe(422);
    expect((await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, attestorWallet: att.address, sourceNote: 'ECB said 1.08 today', signature }, att1Tok)).statusCode).toBe(400);
    const signed = await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, attestorWallet: att.address, sourceNote: 'ecb-reference-rate', signature }, att1Tok, { 'idempotency-key': 'fx-1' });
    expect(signed.statusCode, JSON.stringify(signed.json())).toBe(200);
    expect(signed.json()).toMatchObject({ state: 'signed', attestor: att.address, rateWad, sourceNote: 'ecb-reference-rate', signature });
    expect((await rig.post('/attestor/fx-requests/fxreq_test1/sign', { rateWad, attestorWallet: att.address, sourceNote: 'ecb-reference-rate', signature }, att1Tok)).statusCode).toBe(409);
    expect((await rig.get('/attestor/fx-requests', att1Tok)).json().requests).toEqual([]);
    const forIssuer = await rig.get(`/series/${eur.seriesId}/reporting/fx-fallback/${q.id}`, issuerTok);
    expect(forIssuer.json()).toMatchObject({ pair: 'EUR/USD', state: 'signed', attestorRate: { attestor: att.address, rateWad } });
    const audit = await rig.t.pool.query("select detail from audit_log where action = 'fx.sign' and target = 'fxreq_test1'");
    expect(audit.rows[0].detail).toMatchObject({ pair: 'EUR/USD', rateWad, sourceNote: 'ecb-reference-rate' });
  });

  it('hardship: E2E ciphertext only, private review by the chosen attestor, approvePause signed by the attestor, holders see statuses only', async () => {
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
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.backers[1]!.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(422);

    const ciphertext = e2e(HARDSHIP_PLAIN);
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext, keyHint: 'attestor-1 x25519 key v1' }, issuerTok, { 'idempotency-key': 'hard-1' });
    expect(req.statusCode, JSON.stringify(req.json())).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    expect(req.json()).toMatchObject({ state: 'pending', requestedUntil: until, attestor: att.address });
    expect(req.json().ciphertext).toBeUndefined();
    const tx = req.json().tx as UnsignedTx;
    expect(tx.command).toEqual({ kind: 'requestPause', seriesId, until });
    expect(tx.signer).toBe(h.issuer.address);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext, keyHint: 'attestor-1 x25519 key v1' }, issuerTok, { 'idempotency-key': 'hard-1' })).json().hardshipId).toBe(hardshipId);
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(409);

    // the attestor cannot approve before the issuer's requestPause landed
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: true }, attTok)).statusCode).toBe(409);
    const sent = await rig.post('/tx/send', await h.issuer.sign(tx), issuerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    expect(sent.json().events[0].type).toBe('PauseRequested');
    // the requested end is advisory: recorded beside the request, no pause yet (cause P)
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 0, requested: true, requestedUntil: until, current: null });

    // private review: only the chosen attestor (or an admin) reads the ciphertext
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, att1Tok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, issuerTok)).statusCode).toBe(403);
    expect((await rig.get('/attestor/queue', att1Tok)).json().hardship).toEqual([]);
    expect((await rig.get('/attestor/queue', attTok)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).toEqual([hardshipId]);
    const view = await rig.get(`/attestor/hardship/${hardshipId}`, attTok);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ ciphertext, keyHint: 'attestor-1 x25519 key v1', state: 'pending', pause: { requestedUntil: until, approvedUntil: null, startedAt: null } });
    const adminView = await rig.get(`/attestor/hardship/${hardshipId}`, rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] }));
    expect(adminView.json().ciphertext).toBe(ciphertext);

    // holders and the issuer: statuses and dates only
    const holderView = await rig.get(`/series/${seriesId}/hardship`, holderTok);
    expect(holderView.statusCode).toBe(200);
    expect(holderView.json()).toEqual({ seriesId, seriesStatus: expect.any(String), paused: false, pausedUntil: null, requests: [{ state: 'pending', requestedUntil: until, approvedUntil: null, requestedAt: expect.any(String), decidedAt: null }] });
    expect(JSON.stringify(holderView.json())).not.toMatch(/ciphertext|keyHint|decisionCode|attestor/);

    // decision: not the chosen attestor; approved end after the requested end; then approve with a shorter end
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: true }, att1Tok)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: true, until: until + DAY }, attTok)).statusCode).toBe(422);
    // the chain holds an approval to Stage 1's bounds whoever builds it: an attestor's own approvePause ending more than a
    // year out is PauseTooLong, one ending now is InvalidPauseEnd; both 422 with nothing changed (cause P)
    const chainNow = await h.sim.now();
    for (const [end, name] of [[chainNow + 366 * DAY, 'PauseTooLong'], [chainNow, 'InvalidPauseEnd']] as const) {
      const direct = await rig.post('/tx/send', await att.sign(await h.sim.build({ kind: 'approvePause', seriesId, until: end }, att.address)), attTok);
      expect(direct.statusCode, name).toBe(422);
      expect(direct.json()).toMatchObject({ error: 'ChainInvalidTerms', detail: { stage1: name } });
    }
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 0, requested: true });
    const approvedUntil = until - 30 * DAY;
    const decided = await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: true, until: approvedUntil }, attTok, { 'idempotency-key': 'hard-decide-1' });
    expect(decided.statusCode, JSON.stringify(decided.json())).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'approved', approvedUntil, decisionCode: 'approved' });
    const approveTx = decided.json().tx as UnsignedTx;
    expect(approveTx.command).toEqual({ kind: 'approvePause', seriesId, until: approvedUntil });
    expect(approveTx.signer).toBe(att.address);
    const approved = await rig.post('/tx/send', await att.sign(approveTx), attTok);
    expect(approved.statusCode, JSON.stringify(approved.json())).toBe(200);
    // cause P: approve_pause is a Stage 1 sync point; this series has reported nothing for more than 90 days after its
    // first period ended, so the formal notice and the lateness release block are recorded with the approval
    expect(approved.json().events.map((e: { type: string }) => e.type)).toEqual(['PauseApproved', 'StatusChanged', 'FormalNoticeDue', 'ReleasesPaused']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    // the pause runs from the approval to the approved end, 30 days before the requested one (cause P: the request's end
    // was advisory)
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ count: 1, requested: false, requestedUntil: null, current: { end: approvedUntil } });
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Paused');
    const after = await rig.get(`/series/${seriesId}/hardship`, holderTok);
    expect(after.json()).toMatchObject({ seriesStatus: 'Paused', paused: true, pausedUntil: approvedUntil, requests: [{ state: 'approved', approvedUntil }] });
    expect((await rig.get(`/series/${seriesId}/hardship`, issuerTok)).json().requests[0].state).toBe('approved');
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: false, decisionCode: 'insufficient-evidence' }, attTok)).statusCode).toBe(409);
    expect((await rig.get('/attestor/queue', attTok)).json().hardship).toEqual([]);
    const audit = await rig.t.pool.query('select action, detail from audit_log where target = $1 order by id', [hardshipId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['hardship.approve']);
    expect(JSON.stringify(audit.rows)).not.toContain(CANARY);
    // notifications carry statuses, never reasons
    const outbox = await rig.t.pool.query("select payload from outbox where payload->>'hardshipId' = $1 order by id", [hardshipId]);
    expect(outbox.rows.map((r) => r.payload.kind)).toEqual(['hardship.requested', 'hardship.approved']);
    expect(JSON.stringify(outbox.rows)).not.toMatch(/medical|reason/);

    // a rejection carries a code only
    const paused = (await h.sim.getSeries(seriesId))!;
    expect(paused.status).toBe('Paused');
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: att.address, ciphertext: e2e(HARDSHIP_PLAIN) }, issuerTok)).statusCode).toBe(409); // paused: no new request
  });

  it('extinguishment: two distinct registered attestors sign one transaction; the chain returns unvested treasury to holders', async () => {
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const evidence = e2e(`death certificate ${CANARY}`);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a1.address], evidenceCiphertext: evidence }, attTok)).statusCode).toBe(422);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, h.backers[0]!.address], evidenceCiphertext: evidence }, attTok)).statusCode).toBe(422);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a2.address], evidenceCiphertext: 'death certificate attached as plaintext here' }, attTok)).statusCode).toBe(422);
    // the caller must be one of the two attestors
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a2.address], evidenceCiphertext: evidence }, rig.token({ accountId: 'att-m', wallets: [{ chain: 'monad', address: rig.mon.attestors[0]!.address }], roles: ['attestor'] }))).statusCode).toBe(403);
    const req = await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a2.address], evidenceCiphertext: evidence, keyHint: 'attestors shared key v1' }, attTok, { 'idempotency-key': 'ext-1' });
    expect(req.statusCode, JSON.stringify(req.json())).toBe(201);
    const requestId = req.json().requestId as string;
    expect(req.json()).toMatchObject({ state: 'built', attestors: [a1.address, a2.address] });
    const tx = req.json().tx as UnsignedTx;
    expect(tx.command).toEqual({ kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] });
    expect(tx.signer).toBe(a1.address);
    expect(tx.coSigners).toEqual([a2.address]);
    expect((await rig.get('/attestor/queue', att1Tok)).json().extinguishments.map((x: { requestId: string }) => x.requestId)).toEqual([requestId]);
    expect((await rig.get(`/attestor/extinguish/${requestId}`, issuerTok)).statusCode).toBe(403);
    expect((await rig.get(`/attestor/extinguish/${requestId}`, att1Tok)).json()).toMatchObject({ evidenceCiphertext: evidence, seriesStatus: 'Paused', state: 'built' });
    // one signature is not enough; both attestors sign and the first relays
    const oneSig = await a1.sign(tx);
    expect((await rig.post('/tx/send', oneSig, attTok)).statusCode).toBe(403);
    const sent = await rig.post('/tx/send', await a2.coSign(oneSig), attTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const ext = sent.json().events.find((e: { type: string }) => e.type === 'SeriesExtinguished');
    expect(ext.payload.attestors).toEqual([a1.address, a2.address]);
    // every tranche vested by 2027 (180 days after settlement), so nothing returns to holders: the vested treasury stays
    // drawable by the issuer (G7; was > 0, the whole unreleased treasury)
    expect(ext.payload.returnedToHolders).toBe('0');
    expect(sent.json().events.map((e: { type: string }) => e.type)).not.toContain('PaymentReceived');
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Extinguished');
    expect((await rig.get(`/attestor/extinguish/${requestId}`, attTok)).json()).toMatchObject({ state: 'sent', seriesStatus: 'Extinguished' });
    expect((await rig.get('/attestor/queue', attTok)).json().extinguishments).toEqual([]);
    expect((await rig.post('/attestor/extinguish', { seriesId, attestors: [a1.address, a2.address], evidenceCiphertext: e2e('x'.repeat(40)) }, attTok)).statusCode).toBe(409);
    const audit = await rig.t.pool.query("select detail from audit_log where action = 'extinguishment.request' and target = $1", [requestId]);
    expect(audit.rows[0].detail).toMatchObject({ seriesId, attestors: [a1.address, a2.address] });
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

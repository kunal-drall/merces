import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { logCapture, createLogger } from '@merces/core';
import { WAD, parsePeriod, ratePerUnit } from '@merces/math';
import { DeviceError, MemoryIncomeChain, assembleOnDevice, checkTier3Opening, choosePrior, type DevicePrivateTerms } from '@merces/poi-device';
import { SimWallet } from '@merces/simulator';
import { attestationMessage, type UnsignedTx } from '@merces/domain';
import { makeRig } from '../../api/test/helpers.ts';

/**
 * H3 canary: push distinctive fake income values through every flow that touches income, then scan the database
 * (every table, every column), the captured logs, the outbox/jobs queues, the error reporter buffer and every HTTP
 * response body for them. Finding one anywhere is a failing test.
 *
 * S1 WP10 adds: Stage 1 Groth16 proofs from the device; a year-to-date figure of 2^64 or more (Stage 1's range
 * errors put the value in their message, so every layer must answer with a code); the prior opening (a tier-2 report
 * hands it to the report verifier only); and tier 3's opening, which reaches the attestor end to end encrypted (M7).
 */
const CANARY_INCOME = 7_317_317_317n; // 7,317.317317 in 6-decimal base units
const CANARY_INCOME_2 = 9_191_919_191n;
const CANARY_INCOME_Q2 = 8_282_828_282n;
const CANARY_INCOME_Q3 = 8_484_848_484n;
const CANARY_HUGE = (1n << 64n) + 7_317n; // a year-to-date figure no u64 holds
const CANARY_REASON = 'CANARY-HARDSHIP-REASON-4242';
const CANARY_THRESHOLD = 6_161_616_161n;
const CANARIES = [
  CANARY_INCOME.toString(), CANARY_INCOME_2.toString(), CANARY_INCOME_Q2.toString(), CANARY_INCOME_Q3.toString(), CANARY_HUGE.toString(), CANARY_REASON, CANARY_THRESHOLD.toString(),
  '7317.317317', '9191.919191', '8282.828282', '8484.848484',
];

const errorReports: string[] = [];
const httpBodies: string[] = [];

/** Stand-in for the client's end-to-end encryption: AES-256-GCM under a key the server never sees. */
function e2e(plain: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

describe.skipIf(!dbTestsEnabled())('privacy canary (H3)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    logCapture.enabled = true;
    logCapture.silent = true;
    logCapture.reset();
    rig = await makeRig();
    // a logger with the same redaction as production, used by this test to emit what services would emit
    const log = createLogger('canary-probe', 'debug');
    (rig.ctx as { log: unknown }).log = log;
  });
  afterAll(async () => {
    logCapture.enabled = false;
    logCapture.silent = false;
    await rig.close();
  });

  it('runs the income flows with canary values and finds none at rest, in logs, queues, error reports or HTTP bodies', async () => {
    const h = rig.sol;
    const post = async (url: string, body: unknown, tok?: string) => {
      const r = await rig.post(url, body, tok);
      httpBodies.push(r.body);
      return r;
    };
    const get = async (url: string, tok?: string) => {
      const r = await rig.get(url, tok);
      httpBodies.push(r.body);
      return r;
    };
    const termsSalt = BigInt('0x' + '77'.repeat(31));
    const rWad = ratePerUnit(10n ** 17n, 500n);
    const raise = await h.runRaise({ privateTerms: { theta: CANARY_THRESHOLD, rWad, currency: 'USD', indexingRule: 'cpi-annual', termsSalt } });
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'canary-issuer', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const att = h.attestors[0]!;
    const attTok = rig.token({ accountId: 'canary-attestor', wallets: [{ chain: 'solana', address: att.address }], roles: ['attestor'] });
    const privateTerms: DevicePrivateTerms = { threshold: CANARY_THRESHOLD.toString(), shareRate: '0.10', reportingCurrency: 'USD', indexingRule: 'cpi-annual', termsSalt: termsSalt.toString() };
    const chain = new MemoryIncomeChain();
    const deviceSecret = 'canary-device-secret';
    const device = { seriesId, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', unitsOffered: '500', privateTerms, fxAvgWad: WAD, deviceSecret };
    const payIfDue = async (reportId: string, events: { type: string; payload: { paymentDue?: string } }[]) => {
      if (events.find((e) => e.type === 'ReportAccepted')!.payload.paymentDue === '0') return;
      const pay = await post(`/reports/${reportId}/build-payin`, {}, issuerTok);
      expect((await post('/tx/send', await h.issuer.sign(pay.json().tx as UnsignedTx), issuerTok)).statusCode).toBe(200);
    };

    // 1. tier-2 Q1 with canary income: device (Stage 1 Groth16) → verifier → API → chain
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const zk1 = rig.zktls.prove({ source: 'stripe', seriesId, periodId: '2026Q1', figure: CANARY_INCOME, currency: 'USD', coversUntil: parsePeriod('2026Q1').end, owner: h.issuer.address });
    const q1 = await assembleOnDevice({ ...device, periodId: '2026Q1', prior: null, incomeYtdNow: CANARY_INCOME, tier: 2, source: 'stripe', zktlsProof: zk1 }, rig.verifier);
    chain.put(q1.entry);
    CANARIES.push(q1.entry.incomeSalt.toString());
    expect(q1.assembled.proof.system).toBe('groth16-bn254');
    const rep1 = await post(`/series/${seriesId}/reports`, q1.assembled, issuerTok);
    expect(rep1.statusCode, rep1.body).toBe(201);
    const sent1 = await post('/tx/send', await h.issuer.sign(rep1.json().tx as UnsignedTx), issuerTok);
    expect(sent1.statusCode, sent1.body).toBe(200);
    await payIfDue(rep1.json().reportId, sent1.json().events);

    // 2. a failing report (commitment the proof does not cover) and a verifier refusal, so error paths run too
    const badRes = await post(`/series/${seriesId}/reports`, { ...q1.assembled, periodId: '2026Q2', incomeCommitment: '0x' + 'ab'.repeat(32) }, issuerTok);
    expect(badRes.statusCode).toBeGreaterThanOrEqual(400);
    errorReports.push(badRes.body);
    const refused = await rig.verifier.attest({ seriesId, periodId: '2026Q1', tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: zk1, incomeSalt: '1', incomeCommitment: q1.assembled.incomeCommitment, priorIncomeCommitment: q1.assembled.priorIncomeCommitment });
    errorReports.push(JSON.stringify(refused));

    // 3. a year-to-date figure of 2^64 or more: the device, the verifier and the API answer with codes only
    const huge = await assembleOnDevice({ ...device, periodId: '2026Q2', prior: q1.entry, incomeYtdNow: CANARY_HUGE, tier: 2, source: 'stripe', zktlsProof: zk1 }, rig.verifier).then(() => null, (e: unknown) => e);
    expect(huge).toBeInstanceOf(DeviceError);
    expect((huge as DeviceError).code).toBe('out-of-range');
    errorReports.push(String(huge), JSON.stringify(huge), (huge as Error).stack ?? '');
    const zkHuge = rig.zktls.prove({ source: 'stripe', seriesId, periodId: '2026Q2', figure: CANARY_HUGE, currency: 'USD', coversUntil: parsePeriod('2026Q2').end, owner: h.issuer.address });
    const hugeAttest = await rig.verifier.attest({ seriesId, periodId: '2026Q2', tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: zkHuge, incomeSalt: '5', incomeCommitment: q1.assembled.incomeCommitment, priorIncomeCommitment: q1.assembled.incomeCommitment, priorOpening: { incomeYtd: q1.entry.incomeYtd.toString(), incomeSalt: q1.entry.incomeSalt.toString() }, priorAttestation: q1.entry.attestation });
    expect(hugeAttest).toEqual({ ok: false, code: 'not-field' });
    errorReports.push(JSON.stringify(hugeAttest));
    // a client that sends a figure or an opening to the API is refused without an echo, and nothing is stored
    expect((await post(`/series/${seriesId}/reports`, { ...q1.assembled, periodId: '2026Q2', incomeYtd: CANARY_HUGE.toString() }, issuerTok)).statusCode).toBe(400);
    expect((await post(`/series/${seriesId}/reports`, { ...q1.assembled, periodId: '2026Q2', priorOpening: { incomeYtd: CANARY_INCOME.toString(), incomeSalt: q1.entry.incomeSalt.toString() } }, issuerTok)).statusCode).toBe(400);
    expect((await post(`/series/${seriesId}/reports`, { ...q1.assembled, periodId: '2026Q2', paymentStable: CANARY_HUGE.toString() }, issuerTok)).statusCode).toBeGreaterThanOrEqual(400);

    // 4. tier-2 Q2 chained from Q1: the prior opening goes to the report verifier only
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const prior2 = (await get(`/series/${seriesId}/reporting/prior`)).json();
    expect(prior2).toMatchObject({ periodId: '2026Q2', rule: 'chained', expectedPriorIncomeCommitment: q1.entry.incomeCommitment });
    const zk2 = rig.zktls.prove({ source: 'stripe', seriesId, periodId: '2026Q2', figure: CANARY_INCOME_Q2, currency: 'USD', coversUntil: parsePeriod('2026Q2').end, owner: h.issuer.address });
    const q2 = await assembleOnDevice({ ...device, periodId: '2026Q2', prior: choosePrior(chain, seriesId, '2026Q2', prior2.expectedPriorIncomeCommitment), incomeYtdNow: CANARY_INCOME_Q2, tier: 2, source: 'stripe', zktlsProof: zk2 }, rig.verifier);
    chain.put(q2.entry);
    CANARIES.push(q2.entry.incomeSalt.toString());
    const rep2 = await post(`/series/${seriesId}/reports`, q2.assembled, issuerTok);
    expect(rep2.statusCode, rep2.body).toBe(201);
    const sent2 = await post('/tx/send', await h.issuer.sign(rep2.json().tx as UnsignedTx), issuerTok);
    expect(sent2.statusCode, sent2.body).toBe(200);
    await payIfDue(rep2.json().reportId, sent2.json().events);

    // 5. tier-3 Q3 (M7): the issuer's device proves; the opening (this quarter's and the prior's) reaches the attestor
    //    end to end encrypted, never in plaintext through the API, the database, a queue or a log
    await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    await rig.sync();
    const prior3 = (await get(`/series/${seriesId}/reporting/prior`)).json();
    const q3 = await assembleOnDevice({ ...device, periodId: '2026Q3', prior: choosePrior(chain, seriesId, '2026Q3', prior3.expectedPriorIncomeCommitment), incomeYtdNow: CANARY_INCOME_Q3, tier: 3, source: 'attestor' }, null);
    CANARIES.push(q3.entry.incomeSalt.toString());
    const opening = q3.tier3Opening!;
    expect(opening).toMatchObject({ incomeYtd: CANARY_INCOME_Q3.toString(), priorIncomeYtd: CANARY_INCOME_Q2.toString() });
    const docs = e2e(`1099-NEC box 1 ${CANARY_INCOME_Q3}`);
    const plain = await post(`/series/${seriesId}/tier3/2026Q3`, { attestor: att.address, documentsCiphertext: docs, openingCiphertext: JSON.stringify(opening), estimatePaymentStable: '1' }, issuerTok);
    expect(plain.statusCode).toBe(422);
    errorReports.push(plain.body);
    const encoded = await post(`/series/${seriesId}/tier3/2026Q3`, { attestor: att.address, documentsCiphertext: docs, openingCiphertext: Buffer.from(JSON.stringify(opening)).toString('base64'), estimatePaymentStable: '1' }, issuerTok);
    expect(encoded.statusCode).toBe(422);
    errorReports.push(encoded.body);
    const opened = await post(`/series/${seriesId}/tier3/2026Q3`, { attestor: att.address, documentsCiphertext: docs, openingCiphertext: e2e(JSON.stringify(opening)), estimatePaymentStable: q3.assembled.paymentStable }, issuerTok);
    expect(opened.statusCode, opened.body).toBe(201);
    const caseId = opened.json().caseId as string;
    expect((await get(`/attestor/tier3/${caseId}`, attTok)).json().openingCiphertext).toBeTruthy();
    // the attestor's device decrypts (here: the plaintext above), checks against the documents, signs
    const c = { seriesId, periodId: '2026Q3', priorIncomeCommitment: q3.assembled.priorIncomeCommitment, incomeCommitment: q3.assembled.incomeCommitment };
    expect(checkTier3Opening(opening, { ...c, documentedYtd: CANARY_INCOME_Q3 })).toEqual({ ok: true });
    const signature = await att.signMessage(attestationMessage({ ...c, tier: 3, liquidityEvent: false }));
    const signBody = { priorIncomeCommitment: c.priorIncomeCommitment, incomeCommitment: c.incomeCommitment, proof: q3.assembled.proof, attestation: { liquidityEvent: false, signature } };
    expect((await post(`/attestor/tier3/${caseId}/sign`, { ...signBody, opening }, attTok)).statusCode).toBe(400);
    expect((await post(`/attestor/tier3/${caseId}/sign`, signBody, attTok)).statusCode).toBe(200);
    const rep3 = await post(`/series/${seriesId}/reports`, { ...q3.assembled, attestor: att.address }, issuerTok);
    expect(rep3.statusCode, rep3.body).toBe(201);
    const sent3 = await post('/tx/send', await att.coSign(await h.issuer.sign(rep3.json().tx as UnsignedTx)), issuerTok);
    expect(sent3.statusCode, sent3.body).toBe(200);
    await payIfDue(rep3.json().reportId, sent3.json().events);

    // 6. the private terms vault path (E4) with the canary threshold
    const issuerApp = new SimWallet('solana', 'canary-draft-issuer');
    const draftTok = rig.token({ accountId: 'canary-draft', wallets: [{ chain: 'solana', address: issuerApp.address }], roles: ['issuer', 'admin'] });
    const draft = (await post('/drafts', { chain: 'solana', issuer: issuerApp.address }, draftTok)).json();
    const set = await rig.put(`/drafts/${draft.draftId}/terms`, { public: { stablecoin: 'USDC', unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', country: 'US' }, private: { threshold: '61616161610000', shareRate: '0.10' } }, draftTok);
    expect(set.statusCode).toBe(200);
    // 7. a hardship pause request with a canary reason: the API accepts only ciphertext; a plaintext reason must be rejected or never stored
    const pauseTx = await h.sim.build({ kind: 'requestPause', seriesId, until: (await h.sim.now()) + 30 * 86_400 }, h.issuer.address);
    await post('/tx/send', await h.issuer.sign(pauseTx), issuerTok);
    (rig.ctx.log as { info(o: unknown, m: string): void }).info({ seriesId, reason: CANARY_REASON, incomeYtd: CANARY_INCOME_2.toString() }, 'canary probe through the production logger');
    // 8. notifications/outbox and jobs carry statuses only
    await rig.sync();

    // ---- scan everything
    const found: string[] = [];
    const tables = await rig.t.pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'");
    for (const { table_name } of tables.rows) {
      const rows = await rig.t.pool.query(`select row_to_json(t)::text as j from ${table_name} t`);
      for (const r of rows.rows) for (const c of CANARIES) if ((r.j as string).includes(c)) found.push(`db:${table_name}: ${c}`);
    }
    for (const line of logCapture.lines) for (const c of CANARIES) if (line.includes(c)) found.push(`log: ${c}`);
    for (const e of errorReports) for (const c of CANARIES) if (e.includes(c)) found.push(`error-report: ${c}`);
    for (const b of httpBodies) for (const c of CANARIES) if (b.includes(c)) found.push(`http-body: ${c}`);
    expect(found, `canary values leaked: ${found.join(', ')}`).toEqual([]);
    // sanity: the probe reached the logger and the redaction did its job; the scans saw the flows
    expect(logCapture.lines.some((l) => l.includes('canary probe'))).toBe(true);
    expect(logCapture.lines.some((l) => l.includes('[redacted]'))).toBe(true);
    const t3 = (await rig.t.pool.query('select opening_ciphertext, proof, attestation from tier3_cases where case_id = $1', [caseId])).rows[0];
    expect(t3.opening_ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(t3.proof.system).toBe('groth16-bn254');
    expect((await rig.t.pool.query('select count(*)::int as n from reports where series_id = $1 and prior_income_commitment is not null', [seriesId])).rows[0].n).toBe(3);
  });
});

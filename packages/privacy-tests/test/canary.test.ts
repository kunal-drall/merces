import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { logCapture, createLogger } from '@merces/core';
import { parsePeriod } from '@merces/math';
import { assembleOnDevice } from '@merces/poi-device';
import { SimWallet } from '@merces/simulator';
import type { UnsignedTx } from '@merces/domain';
import { makeRig } from '../../api/test/helpers.ts';

/**
 * H3 canary: push distinctive fake income values through every flow that touches income, then scan the database
 * (every table, every column), the captured logs, the outbox/jobs queues and the error reporter buffer for them.
 * Finding one anywhere is a failing test.
 */
const CANARY_INCOME = 7_317_317_317n; // 7,317.317317 in 6-decimal base units
const CANARY_INCOME_2 = 9_191_919_191n;
const CANARY_REASON = 'CANARY-HARDSHIP-REASON-4242';
const CANARY_THRESHOLD = 6_161_616_161n;
const CANARIES = [CANARY_INCOME.toString(), CANARY_INCOME_2.toString(), CANARY_REASON, CANARY_THRESHOLD.toString(), '7317.317317', '9191.919191'];

const errorReports: string[] = [];

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

  it('runs the income flows with canary values and finds none at rest, in logs, queues or error reports', async () => {
    const h = rig.sol;
    const privateTerms = { threshold: CANARY_THRESHOLD, shareRateWad: 10n ** 17n, reportingCurrency: 'USD', indexingRule: 'cpi-annual' as const, salt: '0x' + '77'.repeat(32) };
    const raise = await h.runRaise({ privateTerms });
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'canary-issuer', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    // 1. tier-2 report with canary income through the device → verifier → API → chain
    const q = '2026Q1';
    await h.sim.setTime(parsePeriod(q).end + 86_400);
    const proof = rig.zktls.prove({ source: 'stripe', seriesId, periodId: q, figure: CANARY_INCOME, currency: 'USD', coversUntil: parsePeriod(q).end, owner: h.issuer.address });
    const { assembled } = await assembleOnDevice({ seriesId, periodId: q, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', unitsOffered: '500', privateTerms: { threshold: CANARY_THRESHOLD.toString(), shareRate: '0.10', reportingCurrency: 'USD' }, incomeYtdPrev: 0n, incomeYtdNow: CANARY_INCOME, fxAvgWad: 10n ** 18n, tier: 2, source: 'stripe', zktlsProof: proof }, rig.verifier);
    const rep = await rig.post(`/series/${seriesId}/reports`, assembled, issuerTok);
    expect(rep.statusCode, JSON.stringify(rep.json())).toBe(201);
    const sent = await rig.post('/tx/send', await h.issuer.sign(rep.json().tx as UnsignedTx), issuerTok);
    expect(sent.statusCode).toBe(200);
    const due = sent.json().events[0].payload.paymentDue as string;
    if (due !== '0') {
      const pay = await rig.post(`/reports/${rep.json().reportId}/build-payin`, {}, issuerTok);
      await rig.post('/tx/send', await h.issuer.sign(pay.json().tx as UnsignedTx), issuerTok);
    }
    // 2. a failing report (verifier refusal) so error paths are exercised too
    const bad = { ...assembled, incomeCommitment: '0x' + 'ab'.repeat(32) };
    const badRes = await rig.post(`/series/${seriesId}/reports`, bad, issuerTok);
    expect(badRes.statusCode).toBe(422);
    errorReports.push(JSON.stringify(badRes.json()));
    const refused = await rig.verifier.attest({ seriesId, periodId: q, tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: '0x' + '00'.repeat(8), incomeCommitment: assembled.incomeCommitment });
    errorReports.push(JSON.stringify(refused));
    // 3. the private terms vault path (E4) with the canary threshold
    const issuerApp = new SimWallet('solana', 'canary-draft-issuer');
    const draftTok = rig.token({ accountId: 'canary-draft', wallets: [{ chain: 'solana', address: issuerApp.address }], roles: ['issuer', 'admin'] });
    const draft = (await rig.post('/drafts', { chain: 'solana', issuer: issuerApp.address }, draftTok)).json();
    const set = await rig.put(`/drafts/${draft.draftId}/terms`, { public: { stablecoin: 'USDC', unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', country: 'US' }, private: { threshold: '61616161610000', shareRate: '0.10' } }, draftTok);
    expect(set.statusCode).toBe(200);
    // 4. a hardship pause request with a canary reason: the API accepts only ciphertext; a plaintext reason must be rejected or never stored
    const pauseTx = await h.sim.build({ kind: 'requestPause', seriesId, until: (await h.sim.now()) + 30 * 86_400 }, h.issuer.address);
    await rig.post('/tx/send', await h.issuer.sign(pauseTx), issuerTok);
    (rig.ctx.log as { info(o: unknown, m: string): void }).info({ seriesId, reason: CANARY_REASON, incomeYtd: CANARY_INCOME_2.toString() }, 'canary probe through the production logger');
    // 5. notifications/outbox and jobs carry statuses only
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
    expect(found, `canary values leaked: ${found.join(', ')}`).toEqual([]);
    // sanity: the probe reached the logger and the redaction did its job
    expect(logCapture.lines.some((l) => l.includes('canary probe'))).toBe(true);
    expect(logCapture.lines.some((l) => l.includes('[redacted]'))).toBe(true);
  });
});

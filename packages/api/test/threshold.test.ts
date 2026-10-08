import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { makeRig } from './helpers.ts';

type Rig = Awaited<ReturnType<typeof makeRig>>;

const ROW = { currency: 'USD', medianFullTimeIncome: '61000000000', inflationIndexBps: 280, source: 'BLS Current Population Survey, median usual weekly earnings × 52', sourceUrl: 'https://www.bls.gov/cps/', retrievedAt: '2027-02-01', placeholder: false };

/** Link an onchain series to a draft + vault row, as the terms service would after createSeries. Metadata only: the ciphertext is never opened. */
async function linkVault(rig: Rig, seriesId: string, draftId: string, chain: string, issuer: string, publicTerms: Record<string, unknown>, commitment: string): Promise<void> {
  await rig.t.pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, terms_commitment, series_id, state) values ($1,$2,$3,$4,$5,$6,$7,'created')", [draftId, `acct-${draftId}`, chain, issuer, JSON.stringify(publicTerms), commitment, seriesId]);
  const ciphertext = rig.ctx.vault.encrypt(JSON.stringify({ threshold: '60000000000', ratePerUnitWad: '200000000000000', reportingCurrency: 'USD', indexingRule: publicTerms.indexingRule ?? 'cpi-annual', salt: '0x' + '11'.repeat(32) }), `terms:${draftId}`);
  await rig.t.pool.query('insert into terms_vault (draft_id, series_id, ciphertext, key_id, commitment, version) values ($1,$2,$3,$4,$5,1)', [draftId, seriesId, ciphertext, rig.ctx.vault.keyId, commitment]);
}

describe.skipIf(!dbTestsEnabled())('E9 threshold data service through the API', () => {
  let rig: Rig;
  let adminTok: string;
  let userTok: string;
  let attestorTok: string;
  const put = (url: string, body: unknown, tok?: string, extra: Record<string, string> = {}) => rig.app.inject({ method: 'PUT', url, payload: body as Record<string, unknown>, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } });
  const del = (url: string, tok?: string, extra: Record<string, string> = {}) => rig.app.inject({ method: 'DELETE', url, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } });

  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [] });
    userTok = rig.token({ accountId: 'user-1', roles: ['backer', 'issuer'], wallets: [], eligible: true });
    attestorTok = rig.token({ accountId: 'att-1', roles: ['attestor'], wallets: [] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('public summary: one line per country with its latest year, placeholder flag and source — no admin fields', async () => {
    const r = await rig.get('/thresholds');
    expect(r.statusCode).toBe(200);
    const countries = r.json().countries as Record<string, unknown>[];
    expect(countries.map((c) => c.country)).toEqual(['CA', 'DE', 'GB', 'IN', 'SG', 'US']);
    const us = countries.find((c) => c.country === 'US')!;
    expect(us).toEqual({ country: 'US', latestYear: 2026, currency: 'USD', placeholder: true, source: 'PLACEHOLDER — ask Kunal for source (Part J.4)' });
    expect(Object.keys(us).sort()).toEqual(['country', 'currency', 'latestYear', 'placeholder', 'source']);
    // the detailed public read from E4 still works alongside
    expect((await rig.get('/thresholds/us')).json().rows[0].year).toBe(2026);
  });

  it('access tiers: admin routes refuse anonymous (401) and non-admin (403) callers; the public summary needs no session', async () => {
    for (const [method, url] of [['GET', '/admin/thresholds'], ['GET', '/admin/thresholds/US/2026/history'], ['GET', '/admin/indexing/2026/candidates']] as const) {
      expect((await rig.app.inject({ method, url })).statusCode, `${method} ${url} anon`).toBe(401);
      expect((await rig.app.inject({ method, url, headers: { authorization: `Bearer ${userTok}` } })).statusCode, `${method} ${url} user`).toBe(403);
      expect((await rig.app.inject({ method, url, headers: { authorization: `Bearer ${attestorTok}` } })).statusCode, `${method} ${url} attestor`).toBe(403);
    }
    expect((await put('/admin/thresholds/US/2027', ROW)).statusCode).toBe(401);
    expect((await put('/admin/thresholds/US/2027', ROW, userTok)).statusCode).toBe(403);
    expect((await put('/admin/thresholds/US/2027', ROW, attestorTok)).statusCode).toBe(403);
    expect((await del('/admin/thresholds/US/2026')).statusCode).toBe(401);
    expect((await del('/admin/thresholds/US/2026', userTok)).statusCode).toBe(403);
    expect((await rig.post('/admin/indexing/2026/notify', {})).statusCode).toBe(401);
    expect((await rig.post('/admin/indexing/2026/notify', {}, userTok)).statusCode).toBe(403);
    expect((await rig.post('/admin/indexing/2026/notify', {}, attestorTok)).statusCode).toBe(403);
    // nothing leaked into the table or the audit log by the refused calls
    expect((await rig.t.pool.query('select count(*)::int as n from threshold_data where year = 2027')).rows[0].n).toBe(0);
    expect((await rig.t.pool.query("select count(*)::int as n from audit_log where action like 'threshold.%' or action = 'indexing.notify'")).rows[0].n).toBe(0);
  });

  it('admin upsert: validation, 201 then 200, history + audit per change, idempotent replay, lower-case country accepted', async () => {
    // a row without a source or without a retrieval date is refused
    const { source: _s, ...noSource } = ROW;
    void _s;
    expect((await put('/admin/thresholds/US/2027', noSource, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/US/2027', { ...ROW, source: '   ' }, adminTok)).statusCode).toBe(400);
    const { retrievedAt: _r, ...noDate } = ROW;
    void _r;
    expect((await put('/admin/thresholds/US/2027', noDate, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/US/2027', { ...ROW, retrievedAt: '2027-13-45' }, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/US/2027', { ...ROW, medianFullTimeIncome: 61000.5 }, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/US/2027', { ...ROW, currency: 'usd' }, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/USA/2027', ROW, adminTok)).statusCode).toBe(400);
    expect((await put('/admin/thresholds/US/1999', ROW, adminTok)).statusCode).toBe(400);

    const created = await put('/admin/thresholds/us/2027', ROW, adminTok, { 'idempotency-key': 'us-2027-v1' });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    expect(created.json().created).toBe(true);
    expect(created.json().row).toMatchObject({ country: 'US', year: 2027, currency: 'USD', medianFullTimeIncome: '61000000000', inflationIndexBps: 280, source: ROW.source, sourceUrl: ROW.sourceUrl, retrievedAt: '2027-02-01', placeholder: false, updatedBy: 'admin-1' });
    // replay with the same key and body returns the stored 201 without a second write
    const replay = await put('/admin/thresholds/us/2027', ROW, adminTok, { 'idempotency-key': 'us-2027-v1' });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().row.updatedAt).toBe(created.json().row.updatedAt);
    // same key, different body → 409
    expect((await put('/admin/thresholds/us/2027', { ...ROW, inflationIndexBps: 290 }, adminTok, { 'idempotency-key': 'us-2027-v1' })).statusCode).toBe(409);
    // an update of the same row is a 200
    const updated = await put('/admin/thresholds/US/2027', { ...ROW, inflationIndexBps: 290, sourceUrl: null }, adminTok);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().created).toBe(false);
    expect(updated.json().row.inflationIndexBps).toBe(290);
    expect(updated.json().row.sourceUrl).toBeNull();
    // the money column stays a string in the DB and the API
    const db = await rig.t.pool.query('select median_full_time_income from threshold_data where country = $1 and year = $2', ['US', 2027]);
    expect(db.rows[0].median_full_time_income).toBe('61000000000');
    // history: insert then update, audited each time with before/after
    const hist = await rig.get('/admin/thresholds/US/2027/history', adminTok);
    expect(hist.json().history.map((h: { op: string; inflationIndexBps: number; changedBy: string }) => [h.op, h.inflationIndexBps, h.changedBy])).toEqual([['insert', 280, 'admin-1'], ['update', 290, 'admin-1']]);
    const audit = await rig.t.pool.query("select action, actor, detail from audit_log where target = 'US:2027' order by id");
    expect(audit.rows.map((a) => a.action)).toEqual(['threshold.insert', 'threshold.update']);
    expect(audit.rows[0].detail.before).toBeNull();
    expect(audit.rows[1].detail.before.inflationIndexBps).toBe(280);
    expect(audit.rows[1].detail.after.inflationIndexBps).toBe(290);
    // the history is append-only
    await expect(rig.t.pool.query('delete from threshold_data_history where country = $1', ['US'])).rejects.toThrow(/append-only/);
    // the public summary now shows the new year and the real-source flag
    const pub = (await rig.get('/thresholds')).json().countries.find((c: { country: string }) => c.country === 'US');
    expect(pub).toEqual({ country: 'US', latestYear: 2027, currency: 'USD', placeholder: false, source: ROW.source });
  });

  it('admin list carries history counts; delete removes the row, records history, audits, and a repeat is 404', async () => {
    const list = await rig.get('/admin/thresholds', adminTok);
    expect(list.statusCode).toBe(200);
    const rows = list.json().rows as { country: string; year: number; historyCount: number; updatedBy: string | null }[];
    expect(rows.find((r) => r.country === 'US' && r.year === 2027)).toMatchObject({ historyCount: 2, updatedBy: 'admin-1' });
    expect(rows.find((r) => r.country === 'US' && r.year === 2026)).toMatchObject({ historyCount: 0, updatedBy: 'seed' });
    expect(rows.map((r) => `${r.country}:${r.year}`)).toEqual(['CA:2026', 'DE:2026', 'GB:2026', 'IN:2026', 'SG:2026', 'US:2027', 'US:2026']);

    const removed = await del('/admin/thresholds/SG/2026', adminTok, { 'idempotency-key': 'del-sg' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ deleted: true, country: 'SG', year: 2026 });
    expect((await del('/admin/thresholds/SG/2026', adminTok, { 'idempotency-key': 'del-sg' })).statusCode).toBe(200); // replay
    expect((await del('/admin/thresholds/SG/2026', adminTok)).statusCode).toBe(404);
    expect((await rig.get('/thresholds/SG')).statusCode).toBe(404);
    expect((await rig.get('/thresholds')).json().countries.map((c: { country: string }) => c.country)).not.toContain('SG');
    const hist = await rig.get('/admin/thresholds/SG/2026/history', adminTok);
    expect(hist.json().history).toHaveLength(1);
    expect(hist.json().history[0]).toMatchObject({ op: 'delete', currency: 'SGD', medianFullTimeIncome: '65000000000', changedBy: 'admin-1' });
    const audit = await rig.t.pool.query("select action from audit_log where target = 'SG:2026'");
    expect(audit.rows.map((a) => a.action)).toEqual(['threshold.delete']);
  });

  it('indexing: candidates are live cpi-annual series with an index for their country and no amendment for the year; notify enqueues once per series and year', async () => {
    // three series: A (US, cpi-annual) is due; B (DE, indexingRule none) is not; C (ZZ, no threshold data) is not
    const a = await rig.sol.runRaise();
    const b = await rig.mon.runRaise();
    const c = await rig.sol.runRaise();
    await rig.sync();
    await linkVault(rig, a.seriesId, 'draft-a', 'solana', rig.sol.issuer.address, { country: 'US', reportingCurrency: 'USD', stablecoin: 'USDC' }, a.terms.termsCommitment);
    await linkVault(rig, b.seriesId, 'draft-b', 'monad', rig.mon.issuer.address, { country: 'DE', reportingCurrency: 'EUR', stablecoin: 'USDC', indexingRule: 'none' }, b.terms.termsCommitment);
    await linkVault(rig, c.seriesId, 'draft-c', 'solana', rig.sol.issuer.address, { country: 'ZZ', reportingCurrency: 'USD', stablecoin: 'USDC' }, c.terms.termsCommitment);

    const cands = await rig.get('/admin/indexing/2026/candidates', adminTok);
    expect(cands.statusCode).toBe(200);
    expect(cands.json().year).toBe(2026);
    expect(cands.json().candidates).toHaveLength(1);
    expect(cands.json().candidates[0]).toMatchObject({ seriesId: a.seriesId, chain: 'solana', issuer: rig.sol.issuer.address, draftId: 'draft-a', country: 'US', inflationIndexBps: 300, indexPlaceholder: true, notified: false, notifiedAt: null });
    // nothing from the vault leaves the service: no ciphertext, no threshold, no salt in the response
    const body = JSON.stringify(cands.json());
    expect(body).not.toContain('ciphertext');
    expect(body).not.toContain('60000000000');
    expect(body).not.toContain('11111111');
    expect((await rig.get('/admin/indexing/1999/candidates', adminTok)).statusCode).toBe(400);

    const n1 = await rig.post('/admin/indexing/2026/notify', {}, adminTok, { 'idempotency-key': 'notify-2026-a' });
    expect(n1.statusCode, JSON.stringify(n1.json())).toBe(200);
    expect(n1.json()).toEqual({ year: 2026, candidates: 1, notified: [a.seriesId], alreadyNotified: [] });
    const outbox = async () => (await rig.t.pool.query("select payload from outbox where topic = 'notification' and payload->>'kind' = 'indexing.due' order by id")).rows.map((r) => r.payload);
    expect(await outbox()).toEqual([{ kind: 'indexing.due', seriesId: a.seriesId, year: 2026 }]);
    // a second call (new idempotency key, or none) nudges nobody again
    const n2 = await rig.post('/admin/indexing/2026/notify', {}, adminTok);
    expect(n2.json()).toEqual({ year: 2026, candidates: 1, notified: [], alreadyNotified: [a.seriesId] });
    expect(await outbox()).toHaveLength(1);
    expect((await rig.get('/admin/indexing/2026/candidates', adminTok)).json().candidates[0].notified).toBe(true);
    const ledger = await rig.t.pool.query('select series_id, year, country, inflation_index_bps, outbox_id, notified_by from indexing_notifications');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ series_id: a.seriesId, year: 2026, country: 'US', inflation_index_bps: 300, notified_by: 'admin-1' });
    expect(ledger.rows[0].outbox_id).not.toBeNull();
    const audit = await rig.t.pool.query("select detail from audit_log where action = 'indexing.notify' and target = '2026' order by id");
    expect(audit.rows.map((r) => r.detail)).toEqual([{ candidates: 1, notified: [a.seriesId], alreadyNotified: [] }, { candidates: 1, notified: [], alreadyNotified: [a.seriesId] }]);

    // once the issuer proposes the year's inflation amendment (any state), the series is no longer a candidate for that year
    await rig.t.pool.query("insert into terms_amendments (amendment_id, series_id, draft_id, kind, new_commitment, new_cap_multiple_wad, ciphertext, version, rationale_code) values ('amend-a', $1, 'draft-a', 'inflation-index', '0xabc', $2, 'x', 2, 'cpi-2026-300bps')", [a.seriesId, a.terms.capMultipleWad]);
    expect((await rig.get('/admin/indexing/2026/candidates', adminTok)).json().candidates).toEqual([]);
    expect((await rig.post('/admin/indexing/2026/notify', {}, adminTok)).json()).toEqual({ year: 2026, candidates: 0, notified: [], alreadyNotified: [] });
    // the next year is a fresh cycle: A is due again as soon as the 2027 US index exists (put in the earlier test)
    const next = (await rig.get('/admin/indexing/2027/candidates', adminTok)).json();
    expect(next.candidates.map((x: { seriesId: string; inflationIndexBps: number; indexPlaceholder: boolean }) => [x.seriesId, x.inflationIndexBps, x.indexPlaceholder])).toEqual([[a.seriesId, 290, false]]);
    // a DE index for 2026 does not make B a candidate (its rule is 'none'); a ZZ index would make C one
    expect((await put('/admin/thresholds/ZZ/2026', { ...ROW, currency: 'ZZD' }, adminTok)).statusCode).toBe(201);
    expect((await rig.get('/admin/indexing/2026/candidates', adminTok)).json().candidates.map((x: { seriesId: string }) => x.seriesId)).toEqual([c.seriesId]);
    // a dead series is not nudged
    await rig.t.pool.query("update series set status = 'Extinguished' where series_id = $1", [c.seriesId]);
    expect((await rig.get('/admin/indexing/2026/candidates', adminTok)).json().candidates).toEqual([]);
  });
});

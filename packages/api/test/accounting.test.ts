import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { parsePeriod } from '@merces/math';
import { makeRig } from './helpers.ts';

type Rig = Awaited<ReturnType<typeof makeRig>>;
const USDC = (n: number) => BigInt(Math.round(n * 1e6)).toString();
/** the income figure fed to the device-side prover; it must never appear in any accounting response */
const INCOME_YTD = 75_000_000_000n;

describe.skipIf(!dbTestsEnabled())('E11 fees and accounting through the API', () => {
  let rig: Rig;
  let seriesId: string;
  let adminTok: string;
  let issuerTok: string;
  let holderTok: string;
  let strangerTok: string;
  let attestorTok: string;

  beforeAll(async () => {
    rig = await makeRig();
    // default raise: 500 units, bids 12/11/10/10/9 USDC × 100 → clears at 9 USDC, proceeds 4,500 USDC, 1% auction fee = 45 USDC (one FeeTaken per winning bidder)
    const a = await rig.sol.runRaise();
    seriesId = a.seriesId;
    await rig.sol.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    // θ = 60,000 USD, share rate 10%: YTD income 75,000 → payment 1,500 USDC; 5% payout fee = 75 USDC; net 1,425 USDC
    const q = await rig.sol.reportAndPay(seriesId, '2026Q1', a.privateTerms, a.terms.termsCommitment, 0n, INCOME_YTD);
    expect(q.due.toString()).toBe(USDC(1500));
    // backer 0 holds 100/500 units → claims 285 USDC; it also claims its bid refund (deposited 12 × 100 × 1.01, paid 9 × 100 × 1.01 → 303 USDC back)
    await rig.sol.exec(rig.sol.backers[0]!, { kind: 'claimPayout', seriesId });
    await rig.sol.exec(rig.sol.backers[0]!, { kind: 'claimRefund', seriesId });
    await rig.sync();
    adminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [] });
    issuerTok = rig.token({ accountId: 'issuer-1', roles: ['issuer'], wallets: [{ chain: 'solana', address: rig.sol.issuer.address }] });
    holderTok = rig.token({ accountId: 'b0', roles: ['backer'], wallets: [{ chain: 'solana', address: rig.sol.backers[0]!.address }] });
    // has the issuer role but is not the issuer of this series
    strangerTok = rig.token({ accountId: 'x', roles: ['issuer', 'backer'], wallets: [{ chain: 'solana', address: 'nobody' }] });
    attestorTok = rig.token({ accountId: 'att-1', roles: ['attestor'], wallets: [{ chain: 'solana', address: rig.sol.attestors[0]!.address }] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('fee ledger: 1% of 4,500 USDC auction and 5% of 1,500 USDC payout as base-unit strings, totals by kind and by series, filters', async () => {
    const r = await rig.get('/admin/accounting/fees?chain=solana', adminTok);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.totals.byKind).toEqual({ auction: USDC(45), payout: USDC(75) });
    expect(body.totals.total).toBe(USDC(120));
    expect(body.totals.bySeries).toEqual([{ seriesId, chain: 'solana', stablecoin: 'USDC', auction: USDC(45), payout: USDC(75), total: USDC(120), count: 6 }]);
    expect(body.rowCount).toBe(6);
    expect(body.truncated).toBe(false);
    const rows = body.rows as { kind: string; payer: string; amount: string; seriesId: string; chain: string; blockTime: number; txId: string }[];
    expect(rows).toHaveLength(6);
    const auction = rows.filter((x) => x.kind === 'auction');
    expect(auction).toHaveLength(5);
    expect(auction.map((x) => x.payer).sort()).toEqual(rig.sol.backers.map((b) => b.address).sort());
    for (const x of auction) expect(x.amount).toBe(USDC(9)); // 1% of 100 units × 9 USDC
    const payout = rows.find((x) => x.kind === 'payout')!;
    expect(payout).toMatchObject({ payer: rig.sol.issuer.address, amount: USDC(75), seriesId, chain: 'solana' });
    for (const x of rows) {
      expect(typeof x.amount).toBe('string');
      expect(x.amount).toMatch(/^\d+$/);
      expect(x.txId).toBeTruthy();
    }
    // the series filter and the time window: from the pay-in block onwards only the payout fee remains
    const bySeries = await rig.get(`/admin/accounting/fees?seriesId=${seriesId}`, adminTok);
    expect(bySeries.json().totals.total).toBe(USDC(120));
    const late = await rig.get(`/admin/accounting/fees?chain=solana&from=${payout.blockTime}`, adminTok);
    expect(late.json().totals.byKind).toEqual({ auction: '0', payout: USDC(75) });
    expect(late.json().rows.map((x: { kind: string }) => x.kind)).toEqual(['payout']);
    const early = await rig.get(`/admin/accounting/fees?chain=solana&to=${payout.blockTime - 1}`, adminTok);
    expect(early.json().totals.byKind).toEqual({ auction: USDC(45), payout: '0' });
    // the limit truncates rows, never totals
    const limited = await rig.get('/admin/accounting/fees?limit=2', adminTok);
    expect(limited.json().rows).toHaveLength(2);
    expect(limited.json().truncated).toBe(true);
    expect(limited.json().totals.total).toBe(USDC(120));
    // monad has no fees yet
    expect((await rig.get('/admin/accounting/fees?chain=monad', adminTok)).json().totals).toEqual({ total: '0', count: 0, byKind: { auction: '0', payout: '0' }, bySeries: [] });
    // validation
    expect((await rig.get('/admin/accounting/fees?chain=bitcoin', adminTok)).statusCode).toBe(400);
    expect((await rig.get('/admin/accounting/fees?from=10&to=5', adminTok)).statusCode).toBe(400);
    expect((await rig.get('/admin/accounting/fees?from=abc', adminTok)).statusCode).toBe(400);
    expect((await rig.get('/admin/accounting/fees?limit=0', adminTok)).statusCode).toBe(400);
  });

  it('statement: gross vs cap, fees by kind, payouts claimed, refunds, treasury — identical for the admin and the issuer, never an income figure', async () => {
    const r = await rig.get(`/admin/accounting/series/${seriesId}`, adminTok);
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ seriesId, chain: 'solana', issuer: rig.sol.issuer.address, stablecoin: 'USDC', phase: 'Settled', status: 'OnTime', feeRates: { auctionFeeBps: 100, payoutFeeBps: 500 } });
    // C6: cap per unit = 2.5 × 9 USDC = 22.5 USDC; 1,500 USDC over 500 units = 3 USDC paid per unit
    expect(s.cap).toMatchObject({
      issuePrice: USDC(9), perUnit: USDC(22.5), unitsSold: '500', unitsOutstanding: '500', total: USDC(11_250),
      paidPerUnitWad: (3n * 10n ** 24n).toString(), paidPerUnit: USDC(3), remainingPerUnit: USDC(19.5), remainingTotal: USDC(9750), progressBps: 1333,
    });
    expect(s.payments).toEqual({ grossPaidTotal: USDC(1500), netDistributed: USDC(1425), feesTaken: USDC(75), count: 1 });
    expect(s.fees).toEqual({ auction: USDC(45), payout: USDC(75), total: USDC(120), vaultFeesTotal: USDC(75) });
    expect(s.payouts).toEqual({ claimed: USDC(285), unclaimed: USDC(1140), count: 1 });
    expect(s.refunds).toEqual({ total: USDC(303), bids: USDC(303), payments: '0' });
    expect(s.treasury).toEqual({ total: USDC(4500), released: '0', balance: USDC(4500), releasesPaused: false });
    expect(s.redemption).toEqual({ price: null, redeemedAt: null, deposit: '0', claimed: '0' });
    expect(s.tail).toEqual({ total: '0' });
    expect(s.extinguishment).toEqual({ extinguishedAt: null, returnedToHolders: '0' });
    expect(s.burns).toEqual({ units: '0' });
    expect(s.periods).toEqual([{ periodId: '2026Q1', tier: 2, paymentDue: USDC(1500), accrual: '0', paid: USDC(1500), splitReceived: '0', reportAccepted: true, settled: true, liquidityEvent: false }]);
    expect(s.moneyEventTotals.fee).toEqual({ count: 6, total: USDC(120) });
    expect(s.moneyEventTotals.payment).toEqual({ count: 1, total: USDC(1500) });
    // every money field is a string
    for (const v of [s.cap.perUnit, s.cap.total, s.payments.grossPaidTotal, s.fees.total, s.payouts.claimed, s.treasury.total]) expect(v).toMatch(/^\d+$/);
    // privacy: the statement carries amounts, never the income behind them
    expect(JSON.stringify(s)).not.toContain(INCOME_YTD.toString());
    expect(JSON.stringify(s)).not.toMatch(/income|threshold/i);

    // the issuer sees the same numbers through their own route
    const mine = await rig.get(`/series/${seriesId}/accounting`, issuerTok);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual(s);
    // an admin passes the issuer tier too
    expect((await rig.get(`/series/${seriesId}/accounting`, adminTok)).statusCode).toBe(200);
    expect((await rig.get('/admin/accounting/series/solana:nope', adminTok)).statusCode).toBe(404);
  });

  it('reconcile: fee collector balance, vault and treasury totals all agree with the read model; the run is persisted, listed, audited and replayable; a drift is detected', async () => {
    const r = await rig.get('/admin/accounting/reconcile', adminTok);
    expect(r.statusCode).toBe(200);
    const run = r.json();
    expect(run.ok).toBe(true);
    expect(run.checksFailed).toBe(0);
    expect(run.actor).toBe('admin-1');
    const checks = run.checks as { check: string; chain: string; seriesId: string | null; stablecoin: string | null; indexed: string; onchain: string; delta: string; ok: boolean }[];
    expect(run.checksTotal).toBe(checks.length);
    expect(checks.every((c) => c.ok && c.delta === '0')).toBe(true);
    // fee collector per chain and stablecoin: solana USDC holds the 120 USDC of fees; USDG and monad are empty
    const collectors = checks.filter((c) => c.check === 'fee-collector-balance').map((c) => [c.chain, c.stablecoin, c.indexed, c.onchain]);
    expect(collectors).toEqual(expect.arrayContaining([['solana', 'USDC', USDC(120), USDC(120)], ['solana', 'USDG', '0', '0'], ['monad', 'USDC', '0', '0']]));
    expect(collectors).toHaveLength(3);
    // the settled series: indexed gross/fees vs the vault, indexed treasury vs the treasury
    const series = checks.filter((c) => c.seriesId === seriesId);
    expect(series.map((c) => [c.check, c.indexed, c.onchain])).toEqual([
      ['vault-gross', USDC(1500), USDC(1500)],
      ['vault-fees', USDC(75), USDC(75)],
      ['treasury-total', USDC(4500), USDC(4500)],
      ['treasury-released', '0', '0'],
    ]);
    // persisted and listed
    const persisted = await rig.t.pool.query('select ok, checks_total, checks_failed, actor from reconciliation_runs where run_id = $1', [run.runId]);
    expect(persisted.rows[0]).toEqual({ ok: true, checks_total: checks.length, checks_failed: 0, actor: 'admin-1' });
    const runs = await rig.get('/admin/accounting/reconcile/runs', adminTok);
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs[0]).toEqual(run);
    // audited
    const audit = await rig.t.pool.query("select actor, actor_role, detail from audit_log where action = 'accounting.reconcile' and target = $1", [run.runId]);
    expect(audit.rows[0]).toEqual({ actor: 'admin-1', actor_role: 'admin', detail: { ok: true, checksTotal: checks.length, checksFailed: 0 } });
    // an Idempotency-Key replays the same run instead of recording another
    const k1 = await rig.app.inject({ method: 'GET', url: '/admin/accounting/reconcile', headers: { authorization: `Bearer ${adminTok}`, 'idempotency-key': 'recon-1' } });
    const k2 = await rig.app.inject({ method: 'GET', url: '/admin/accounting/reconcile', headers: { authorization: `Bearer ${adminTok}`, 'idempotency-key': 'recon-1' } });
    expect(k2.json().runId).toBe(k1.json().runId);
    expect((await rig.get('/admin/accounting/reconcile/runs?limit=1', adminTok)).json().runs).toHaveLength(1);
    expect(Number((await rig.t.pool.query('select count(*) as n from reconciliation_runs')).rows[0].n)).toBe(2);
    // drift: a stablecoin reaching the fee collector outside the ledger shows up as a delta on exactly that check
    const feeCollector = (await rig.sol.sim.info()).feeCollector;
    await rig.sol.sim.fund(feeCollector, 'USDC', 1n);
    const drifted = (await rig.get('/admin/accounting/reconcile', adminTok)).json();
    expect(drifted.ok).toBe(false);
    expect(drifted.checksFailed).toBe(1);
    const bad = drifted.checks.find((c: { ok: boolean }) => !c.ok);
    expect(bad).toMatchObject({ check: 'fee-collector-balance', chain: 'solana', stablecoin: 'USDC', indexed: USDC(120), onchain: (BigInt(USDC(120)) + 1n).toString(), delta: '1', ok: false });
  });

  it('export: text/csv with a header, one row per money event, a filename, filters, and an audit entry', async () => {
    const r = await rig.get('/admin/accounting/export?chain=solana', adminTok);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="merces-money-events_solana_genesis_latest\.csv"$/);
    const lines = r.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('chain,seq,block_time,series_id,period_id,kind,wallet,amount,tx_id,stablecoin');
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows.length).toBeGreaterThanOrEqual(9); // treasury, 5 fees, payment, payout fee, payout, refund
    expect(Number(r.headers['x-row-count'])).toBe(rows.length);
    for (const row of rows) {
      expect(row).toHaveLength(10);
      expect(row[0]).toBe('solana');
      expect(row[2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row[3]).toBe(seriesId);
      expect(row[7]).toMatch(/^\d+$/);
      expect(row[9]).toBe('USDC');
    }
    const kinds = rows.map((x) => x[5]);
    expect(kinds.filter((k) => k === 'fee')).toHaveLength(6);
    expect(rows.find((x) => x[5] === 'payout')).toEqual(expect.arrayContaining([rig.sol.backers[0]!.address, USDC(285)]));
    expect(rows.find((x) => x[5] === 'payment')!.slice(4, 8)).toEqual(['2026Q1', 'payment', '', USDC(1500)]);
    expect(rows.find((x) => x[5] === 'treasury')![7]).toBe(USDC(4500));
    expect(rows.find((x) => x[5] === 'refund')![7]).toBe(USDC(303));
    expect(r.body).not.toContain(INCOME_YTD.toString());
    // audited with the filter and the row count
    const audit = await rig.t.pool.query("select actor, actor_role, target, detail from audit_log where action = 'accounting.export' order by id");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toEqual({ actor: 'admin-1', actor_role: 'admin', target: 'solana', detail: { chain: 'solana', from: null, to: null, rows: rows.length, filename: 'merces-money-events_solana_genesis_latest.csv' } });
    // a window: everything from the pay-in block onwards (payment, payout fee, payout, refund)
    const payin = Math.floor(new Date(rows.find((x) => x[5] === 'payment')![2]!).getTime() / 1000);
    const windowed = await rig.get(`/admin/accounting/export?chain=solana&from=${payin}`, adminTok);
    const wrows = windowed.body.trimEnd().split('\r\n').slice(1);
    expect(wrows.length).toBeLessThan(rows.length);
    expect(wrows.every((l) => ['payment', 'fee', 'payout', 'refund'].includes(l.split(',')[5]!))).toBe(true);
    expect(windowed.headers['content-disposition']).toContain(`_solana_${new Date(payin * 1000).toISOString().slice(0, 10)}_latest.csv`);
    // an empty chain still returns a header
    const empty = await rig.get('/admin/accounting/export?chain=monad', adminTok);
    expect(empty.body.trimEnd().split('\r\n')).toEqual(['chain,seq,block_time,series_id,period_id,kind,wallet,amount,tx_id,stablecoin']);
    expect((await rig.get('/admin/accounting/export?chain=bitcoin', adminTok)).statusCode).toBe(400);
    expect(Number((await rig.t.pool.query("select count(*) as n from audit_log where action = 'accounting.export'")).rows[0].n)).toBe(3);
  });

  it('access tiers: admin routes refuse anonymous (401), holders, issuers and attestors (403); the issuer route refuses holders, strangers and attestors', async () => {
    for (const url of ['/admin/accounting/fees', `/admin/accounting/series/${seriesId}`, '/admin/accounting/reconcile', '/admin/accounting/reconcile/runs', '/admin/accounting/export']) {
      expect((await rig.get(url)).statusCode, `${url} anon`).toBe(401);
      expect((await rig.get(url, holderTok)).statusCode, `${url} holder`).toBe(403);
      expect((await rig.get(url, issuerTok)).statusCode, `${url} issuer`).toBe(403);
      expect((await rig.get(url, attestorTok)).statusCode, `${url} attestor`).toBe(403);
    }
    expect((await rig.get(`/series/${seriesId}/accounting`)).statusCode).toBe(401);
    expect((await rig.get(`/series/${seriesId}/accounting`, holderTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/accounting`, strangerTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/accounting`, attestorTok)).statusCode).toBe(403);
    // denied calls leave no trace: no extra reconciliation runs or exports were recorded
    expect(Number((await rig.t.pool.query('select count(*) as n from reconciliation_runs')).rows[0].n)).toBe(3);
    expect(Number((await rig.t.pool.query("select count(*) as n from audit_log where action = 'accounting.export'")).rows[0].n)).toBe(3);
  });
});

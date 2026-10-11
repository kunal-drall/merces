import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { makeContext } from '@merces/api';
import type { ChainRegistry } from '@merces/chains';
import { KeeperScheduler, statusCrankJob } from '@merces/keepers';
import type { UnsignedTx } from '@merces/domain';
import { WAD, periodOf } from '@merces/math';
import { createServiceContext } from '@merces/services';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;

/**
 * S1 WP11: the offchain mirrors and read consumers on Stage 1's rules. The redemption quote and its blockers follow
 * Stage 1's `redeem`; payIn is built for the open due with its live accrual; the Series row and the periods carry the
 * indexed reporting ledger; the status crank runs at the deadline instants; the statement shows each pool once.
 *
 * Cause code on the HTTP pins that moved (S1 WP12): E, Stage 1's error names and their codes: a payIn with no open due
 * is NothingDue (code WrongStatus, HTTP 422), whether nothing was reported or the due was paid.
 * S4 cause code: S4-PAU, a pause approval is the attestor key's PAUSE signature over the live nonce, relayed by the
 * keeper (S4 WP10; was the attestor's wallet sending it).
 */
describe.skipIf(!dbTestsEnabled())('Stage 1 reads through the API (WP11)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('quote blockers follow Stage 1 redeem; the reporting ledger is served; payIn is the open due with its live accrual; the crank waits for the indexed status', async () => {
    const h = rig.sol;
    const raise = await h.runRaise({ terms: { lockupSeconds: 30 * 86_400 } });
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'w11-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'w11-b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const q = periodOf((await h.sim.getSeries(seriesId))!.settledAt!);
    const next = periodOf(q.end).id;
    const quote = async () => {
      const r = await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };

    // in the lockup: Stage 1 labels, nothing else in the way
    let qt = await quote();
    expect(qt).toMatchObject({ blockedBy: ['LockupActive'], redeemable: false, decidedBy: 'hurdle', boundBy: 'hurdle', outcome: 'redeem', note: null });
    expect(qt.terms.dAvg).toBeNull(); // less than a settlement year: no k × D_avg term
    expect(qt.pricePerUnit).toBe(qt.terms.hurdlePrice);

    // 50 days after the first period ended, unreported: Late (countdown > 45 days) and UnreportedPeriods
    await h.sim.setTime(q.end + 50 * 86_400);
    qt = await quote();
    expect(qt.blockedBy).toEqual(['SeriesLate', 'UnreportedPeriods']);
    expect(qt.blockers[1]).toContain(q.id);

    // the status crank runs once the instant passed, and not again once the indexer has the chain's stored status
    await rig.sync();
    const submits: string[] = [];
    const counted = new Proxy(h.sim, {
      get(target, k) {
        if (k === 'submit') return async (cmd: Parameters<typeof target.submit>[0], signer: Parameters<typeof target.submit>[1]) => { submits.push(cmd.kind); return target.submit(cmd, signer); };
        const v = Reflect.get(target, k);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const reg: ChainRegistry = { chains: new Map([[h.sim.chain, counted]]), decisions: [], stage1: null, get: () => counted, byFamily: () => counted, close: async () => undefined };
    const sched = new KeeperScheduler(createServiceContext(makeContext({ pool: rig.t.pool, chains: reg, log: silent, sessionSecret: 's', devMode: true })), [statusCrankJob]);
    expect((await sched.runAll())['status.crank']!.actions).toBe(1);
    expect(submits).toEqual(['crankStatus']);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}`)).json().status).toBe('Late');
    await sched.runAll();
    expect(submits).toEqual(['crankStatus']); // the indexed status is the derived one: nothing to record

    // nothing reported yet: nothing is due (cause E: was NotFound "no accepted report for this period", HTTP 404)
    const early = await rig.post('/tx/send', await h.issuer.sign(await h.sim.build({ kind: 'payIn', seriesId, periodId: q.id, amount: '1' }, h.issuer.address)), issuerTok);
    expect(early.statusCode).toBe(422);
    expect(early.json()).toMatchObject({ error: 'ChainWrongStatus', detail: { stage1: 'NothingDue' } });

    // report the quarter without paying: the due is open
    const rep = await h.buildReport({ seriesId, periodId: q.id, privateTerms: raise.privateTerms, incomeYtdNow: USDC(100_000) });
    await h.exec(h.issuer, rep.command);
    qt = await quote();
    expect(qt.blockedBy).toEqual(['SeriesLate', 'PaymentOutstanding']);
    await rig.sync();
    // the public row says a due is open, never its amount (payment amounts are for holders and the issuer)
    const pub = (await rig.get(`/series/${seriesId}`)).json();
    expect(pub).toMatchObject({ firstPeriod: q.id, nextExpectedPeriod: next, lastAcceptedPeriod: q.id, lastPaidPeriod: null, openDuePeriod: q.id, paymentOutstanding: true, formalNoticeEmittedFor: null });
    expect(pub).not.toHaveProperty('openDueAmount');
    const per = await rig.get(`/series/${seriesId}/periods`, holderTok);
    expect(per.statusCode).toBe(200);
    expect(per.json().reporting).toEqual({ firstPeriod: q.id, nextExpectedPeriod: next, lastAcceptedPeriod: q.id, lastPaidPeriod: null, openDuePeriod: q.id, openDueAmount: rep.paymentStable.toString(), formalNoticeEmittedFor: null });
    const live = per.json().periods.find((p: { periodId: string }) => p.periodId === q.id);
    // the live due adds Stage 1's lateness accrual (5 whole late days) to the due as reported
    expect(BigInt(live.accrual)).toBeGreaterThan(0n);
    expect(BigInt(live.paymentDue)).toBe(rep.paymentStable + BigInt(live.accrual));
    expect(live.priorIncomeCommitment).toBe(rep.command.priorIncomeCommitment);
    expect((await rig.get(`/series/${seriesId}/periods`)).statusCode).toBe(401);

    // payIn for the open due at the live amount (the report row as the assemble step would have stored it)
    await rig.t.pool.query(
      "insert into reports (report_id, series_id, period_id, account_id, tier, source, state, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof) values ($1,$2,$3,'w11-iss',2,'stripe','accepted',$4,$5,$6,'unity',$7,$8)",
      ['rep_w11', seriesId, q.id, rep.paymentStable.toString(), rep.command.incomeCommitment, raise.terms.termsCommitment, WAD.toString(), JSON.stringify(rep.command.proof)],
    );
    const pay = await rig.post('/reports/rep_w11/build-payin', {}, issuerTok);
    expect(pay.statusCode, pay.body).toBe(200);
    expect(pay.json()).toMatchObject({ periodId: q.id, amount: live.paymentDue, accrual: live.accrual });
    expect((pay.json().tx as UnsignedTx).command).toMatchObject({ kind: 'payIn', periodId: q.id, amount: live.paymentDue });
    const paid = await rig.post('/tx/send', await h.issuer.sign(pay.json().tx as UnsignedTx), issuerTok);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().events.find((e: { type: string }) => e.type === 'PaymentReceived').payload).toMatchObject({ periodId: q.id, paymentDue: live.paymentDue, accrual: live.accrual });
    expect((await rig.post('/reports/rep_w11/build-payin', {}, issuerTok)).statusCode).toBe(409);
    // a chain refusal carries Stage 1's error name (cause E: a paid period was Duplicate, also HTTP 422)
    const again = await rig.post('/tx/send', await h.issuer.sign(await h.sim.build({ kind: 'payIn', seriesId, periodId: q.id, amount: '1' }, h.issuer.address)), issuerTok);
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ error: 'ChainWrongStatus', detail: { stage1: 'NothingDue' } });

    // paid and reported up to date: redeemable; a Paused series may redeem too (Stage 1; the version-1 API refused it)
    qt = await quote();
    expect(qt).toMatchObject({ blockedBy: [], blockers: [], redeemable: true, outcome: 'redeem' });
    const until = (await h.sim.now()) + 30 * 86_400;
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until });
    await h.sim.submit(await h.pauseApproval(seriesId, until), 'keeper'); // cause S4-PAU
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    expect((await quote()).blockedBy).toEqual([]);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ lastPaidPeriod: q.id, openDuePeriod: null, paymentOutstanding: false });
  });

  it('the cap room is Stage 1\'s C_remaining (paid rounded up); with none left, redeem retires the series instead', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const seriesId = raise.seriesId;
    const issuerTok = rig.token({ accountId: 'w11-iss-m', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const adminTok = rig.token({ accountId: 'w11-adm', roles: ['admin'], wallets: [] });
    const q = periodOf((await h.sim.getSeries(seriesId))!.settledAt!);
    await h.sim.setTime(q.end + 86_400);
    // 10,000.000001 USDC over 500 units: 20.000000002 per unit, so the paid amount rounds up to 20.000001
    const r = await h.reportAndPay(seriesId, q.id, raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(160_000) + 10n);
    expect(r.paid).toBe(10_000_000_001n);
    await rig.sync();
    const st = (await rig.get(`/admin/accounting/series/${seriesId}`, adminTok)).json();
    // 22.5 − 20.000001 (Stage 1 ceil; was 22.5 − 20 = 2.5 with the floor)
    expect(st.cap).toMatchObject({ perUnit: USDC(22.5).toString(), paidPerUnit: USDC(20).toString(), remainingPerUnit: '2499999', remainingTotal: (2_499_999n * 500n).toString() });
    expect((await rig.get(`/series/${seriesId}/retirement`)).json().capRemaining).toBe('2499999');
    let qt = (await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok)).json();
    expect(qt.terms.capRemaining).toBe('2499999');
    expect(qt.outcome).toBe('redeem');
    // an issuer-favourable amendment lowers the cap below what was paid: nothing is left of it
    await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: raise.terms.termsCommitment, capMultipleWad: (2n * WAD).toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    qt = (await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok)).json();
    expect(qt).toMatchObject({ outcome: 'retire', decidedBy: 'cap_remaining', boundBy: 'cap', pricePerUnit: '0', deposit: '0', tailCapPerUnit: '0', redeemable: true, blockedBy: [] });
    expect(qt.terms.capRemaining).toBe('0');
    expect(qt.note).toContain('retires the series');
    const built = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: '0' }, issuerTok);
    expect(built.statusCode, built.body).toBe(200);
    const sent = await rig.post('/tx/send', await h.issuer.sign(built.json().tx as UnsignedTx), issuerTok);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().events.map((e: { type: string }) => e.type)).toEqual(['StatusChanged', 'SeriesRetired']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Retired');
    expect(await h.sim.getRedemption(seriesId)).toBeNull();
    await rig.sync();
    // the indexer's cap after the amendment is Stage 1's, and the blockers now name the terminal status
    expect((await rig.get(`/series/${seriesId}`)).json().capPerUnit).toBe(USDC(18).toString());
    expect((await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok)).json().blockedBy).toEqual(['TerminalStatus']);
  });

  // S1 review: a split receipt that reaches the cap retires the series with a reported due unpaid. Stage 1's `retire`
  // clears the open due; the served row said a payment was outstanding on a Retired series, for good.
  it('a series retired by a split receipt has no open due: the Series row and the reporting ledger say so', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: false, tier3: false, tier4: false } } });
    const seriesId = raise.seriesId;
    const holderTok = rig.token({ accountId: 'w11-split-b0', wallets: [{ chain: 'monad', address: h.backers[0]!.address }], roles: ['backer'] });
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    const q = periodOf((await h.sim.getSeries(seriesId))!.settledAt!);
    await h.sim.setTime(q.end + 86_400);
    const rep = await h.buildReport({ seriesId, periodId: q.id, privateTerms: raise.privateTerms, incomeYtdNow: USDC(100_000), tier: 1 });
    await h.exec(h.issuer, rep.command);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ status: 'OnTime', openDuePeriod: q.id, paymentOutstanding: true });
    await h.sim.postSplitReceipt(h.router, seriesId, USDC(20_000));
    expect((await h.sim.getSeries(seriesId))!.reporting).toMatchObject({ openDuePeriod: null, openDueAmount: '0' });
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}`)).json()).toMatchObject({ status: 'Retired', lastPaidPeriod: null, openDuePeriod: null, paymentOutstanding: false });
    const per = await rig.get(`/series/${seriesId}/periods`, holderTok);
    expect(per.statusCode).toBe(200);
    expect(per.json().reporting).toMatchObject({ lastPaidPeriod: null, openDuePeriod: null, openDueAmount: '0' });
  });
});

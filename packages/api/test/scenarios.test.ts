import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { makeContext } from '@merces/api';
import { KeeperScheduler, deadlineRemindersJob, fxCoverageJob, pauseCrankJob, statusCrankJob, transferWindowsJob } from '@merces/keepers';
import { setFlag } from '@merces/core';
import { orderCommitment, type UnsignedTx } from '@merces/domain';
import { parsePeriod, ratePerUnit, wadFromDecimal } from '@merces/math';
import { makeRig } from './helpers.ts';

/**
 * H1 — scenario tests at the service level, through the API, on the simulator. The chain-level twins live in
 * packages/simulator/test; these drive the same mechanics through builders, the tx relay, the read model and the
 * keepers, and assert what the API shows to each party.
 */
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
void makeContext;

describe.skipIf(!dbTestsEnabled())('H1 scenarios through the API', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  const send = async (wallet: { sign(tx: UnsignedTx): Promise<unknown> }, tx: UnsignedTx, tok: string) => {
    const r = await rig.post('/tx/send', await wallet.sign(tx), tok);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { txId: string; events: { type: string; payload: Record<string, string> }[] };
  };
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('cap hit with refund and burn: the issuer is refunded the excess, the series retires, holders keep claims after the burn crank', async () => {
    const h = rig.sol;
    const raise = await h.runRaise();
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'cap-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'cap-b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    // 200k income → 14,000 gross against an 11,250 lifetime cap (22.5 × 500)
    const r = await h.reportAndPay(seriesId, '2026Q1', raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(200_000));
    expect(r.events.map((e) => e.type)).toContain('SeriesRetired');
    expect((r.events.find((e) => e.type === 'PaymentRefunded')!.payload as { amount: string }).amount).toBe(USDC(2750).toString());
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Retired');
    const ret = await rig.get(`/series/${seriesId}/retirement`);
    expect(ret.json()).toMatchObject({ retired: true, capProgressBps: 10_000, burnable: true, holdersWithUnits: 5 });
    const periods = await rig.get(`/series/${seriesId}/periods`, issuerTok);
    expect(periods.json().periods[0].paid).toBe(USDC(11_250).toString());
    // the burn crank (admin trigger here; the keeper runs the same) burns every holder; claims survive
    expect((await rig.post(`/series/${seriesId}/retirement/crank-burn`, {}, adminTok)).json()).toEqual({ burned: 5 });
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}`)).json().unitsOutstanding).toBe('0');
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(claim.statusCode).toBe(200);
    expect(claim.json().claimable).toBe((USDC(11_250) * 95n / 100n / 5n).toString());
    const sent = await send(h.backers[0]!, claim.json().tx as UnsignedTx, holderTok);
    expect(sent.events[0]!.type).toBe('PayoutClaimed');
    await rig.sync();
    const holdings = await rig.get('/me/holdings', holderTok);
    const hld = holdings.json().holdings.find((x: { seriesId: string }) => x.seriesId === seriesId);
    expect(hld).toMatchObject({ units: '0', burnedUnits: '100', status: 'Retired' });
    expect(hld.realisedYieldBps).toBe(Math.floor((2137.5 / 900) * 10_000));
  });

  it('late payment: InGrace → Late pauses releases, accrual is added, paying resumes releases, formal notice is recorded', async () => {
    const h = rig.mon;
    const raise = await h.runRaise();
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'late-iss', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const sched = new KeeperScheduler(rig.ctx as never, [statusCrankJob, deadlineRemindersJob]);
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 31 * 86_400);
    await sched.runAll();
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('InGrace');
    await h.sim.setTime(q1.end + 46 * 86_400);
    await sched.runAll();
    await rig.sync();
    const st = await rig.get(`/series/${seriesId}/status`);
    expect(st.json()).toMatchObject({ status: 'Late', releasesPaused: true });
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).json().message).toContain('Late');
    await h.sim.setTime(q1.end + 121 * 86_400);
    await sched.runAll();
    await rig.sync();
    const sched2 = await rig.get(`/series/${seriesId}/reporting/schedule`, issuerTok);
    const q1View = sched2.json().periods.find((p: { periodId: string }) => p.periodId === '2026Q1');
    expect(q1View.standing).toBe('FormalNoticeDue');
    expect(q1View.nextStep).toBe('assemble-report');
    // pay 76 days after grace: accrual 4000 × 8% × 76/365
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', unitsOutstanding: 500n, privateTerms: raise.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(100_000), termsCommitment: raise.terms.termsCommitment });
    const acc = await send(h.issuer, await h.sim.build(command, h.issuer.address), issuerTok);
    // the report opens the due without accrual (Stage 1 `Report.due`); accrual runs until the payment lands
    expect([acc.events[0]!.payload.paymentDue, acc.events[0]!.payload.accrual]).toEqual([USDC(4000).toString(), '0']);
    const live = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    const accrual = BigInt(live.accrual);
    expect(accrual).toBe((USDC(4000) * wadFromDecimal('0.08') * 76n) / (10n ** 18n * 365n));
    expect(BigInt(live.paymentDue)).toBe(USDC(4000) + accrual);
    const pay = await send(h.issuer, await h.sim.build({ kind: 'payIn', seriesId, periodId: '2026Q1', amount: live.paymentDue }, h.issuer.address), issuerTok);
    expect(pay.events.map((e) => e.type)).toContain('ReleasesResumed');
    await rig.sync();
    const periods = await rig.get(`/series/${seriesId}/periods`, issuerTok);
    const p1 = periods.json().periods.find((p: { periodId: string }) => p.periodId === '2026Q1');
    expect(p1.accrual).toBe(accrual.toString());
    expect(p1.formalNoticeIssued).toBe(true);
    // cause G2: Q2 ended exactly 30 days ago, and Stage 1 counts a countdown of ≤ 30 days as OnTime (was InGrace)
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('OnTime');
    // nothing slashed: the treasury balance is intact and drawable again
    const draw = await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok);
    expect(draw.statusCode).toBe(200);
    const reminders = await rig.t.pool.query('select kind from reminders_sent where target like $1 order by kind', [`${seriesId}:2026Q1%`]);
    expect(reminders.rows.map((r) => r.kind)).toEqual(['grace-end', 'report-due', 'report-due-soon']);
  });

  it('hardship pause across a deadline: deadlines defer, holders see only the status, the crank ends the pause', async () => {
    const h = rig.sol;
    const raise = await h.runRaise();
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'hp-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'hp-b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), q.end + 10 * 86_400));
    const until = (await h.sim.now()) + 90 * 86_400;
    await send(h.issuer, await h.sim.build({ kind: 'requestPause', seriesId, until }, h.issuer.address), issuerTok);
    const attTok = rig.token({ accountId: 'att', roles: ['attestor'], wallets: [{ chain: 'solana', address: h.attestors[0]!.address }] });
    await send(h.attestors[0]!, await h.sim.build({ kind: 'approvePause', seriesId, until }, h.attestors[0]!.address), attTok);
    await rig.sync();
    const sched = new KeeperScheduler(rig.ctx as never, [statusCrankJob, pauseCrankJob]);
    await h.sim.setTime((await h.sim.now()) + 60 * 86_400); // well past what would have been Late
    await sched.runAll();
    await rig.sync();
    const status = await rig.get(`/series/${seriesId}/status`);
    expect(status.json().status).toBe('Paused');
    expect(status.json().periods.find((p: { periodId: string }) => p.periodId === q.id).standing).toBe('Deferred');
    expect(JSON.stringify(status.json())).not.toMatch(/reason/i);
    const feed = await rig.get(`/series/${seriesId}/activity`);
    expect(feed.json().activity.map((a: { summary: string }) => a.summary)).toContain('Hardship pause approved');
    const holdings = await rig.get('/me/holdings', holderTok);
    expect(holdings.json().holdings.find((x: { seriesId: string }) => x.seriesId === seriesId).status).toBe('Paused');
    await h.sim.setTime(until + 1);
    await sched.runAll();
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('OnTime');
    const periods = await rig.get(`/series/${seriesId}/periods`, issuerTok);
    const p = periods.json().periods.find((x: { periodId: string }) => x.periodId === q.id);
    expect(p.dueAt).toBeGreaterThan(q.end + 30 * 86_400); // deferred by the pause
  });

  it('tail clause through the API: a hurdle-bound redemption leaves tail room; a liquidity event pays it, capped', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { lockupSeconds: 30 * 86_400 } });
    const seriesId = raise.seriesId;
    const issuerTok = rig.token({ accountId: 'tail-iss', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'tail-b0', wallets: [{ chain: 'monad', address: h.backers[0]!.address }], roles: ['backer'] });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), q.end + 86_400, settledAt + 31 * 86_400));
    await h.reportAndPay(seriesId, q.id, raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(10_000));
    for (const p of await h.sim.listPeriods(seriesId)) if (!p.settled) await h.reportAndPay(seriesId, p.periodId, raise.privateTerms, raise.terms.termsCommitment, USDC(10_000), USDC(10_000));
    await rig.sync();
    const quote = await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
    expect(quote.json().boundBy).toBe('hurdle');
    expect(BigInt(quote.json().tailCapPerUnit)).toBeGreaterThan(0n);
    const redeem = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: quote.json().pricePerUnit }, issuerTok);
    await send(h.issuer, redeem.json().tx as UnsignedTx, issuerTok);
    await rig.sync();
    let view = await rig.get(`/series/${seriesId}/redemption`, holderTok);
    expect(view.json().tail.open).toBe(true);
    // liquidity event in the next quarter: capped per unit at the tail cap
    const nextQ = (await h.sim.listPeriods(seriesId)).find((p) => !p.settled) ?? null;
    const period = parsePeriod(nextQ?.periodId ?? `${q.year}Q${q.quarter === 4 ? 1 : q.quarter + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), period.end + 86_400));
    const tail = await h.reportAndPay(seriesId, period.id, raise.privateTerms, raise.terms.termsCommitment, USDC(10_000), USDC(5_000_000), { liquidityEvent: true });
    // the report opens the full payment; the cap applies when it is paid (Stage 1 `tailReceive`), the rest is refunded
    expect(tail.due).toBe(tail.paymentStable);
    const payout = tail.events.find((e) => e.type === 'TailPayout')!.payload as { total: string };
    expect(BigInt(payout.total)).toBe(BigInt(quote.json().tailCapPerUnit) * 500n);
    await rig.sync();
    view = await rig.get(`/series/${seriesId}/redemption`, holderTok);
    expect(view.json().tail.open).toBe(false);
    expect(view.json().tail.payouts).toHaveLength(1);
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(BigInt(claim.json().tailClaimable)).toBeGreaterThan(0n);
  });

  it('extinguishment: two attestors end all claims; unreleased treasury returns to holders; nothing else is owed', async () => {
    const h = rig.sol;
    const raise = await h.runRaise();
    const seriesId = raise.seriesId;
    await rig.sync();
    const att1 = rig.token({ accountId: 'ex-a1', roles: ['attestor'], wallets: [{ chain: 'solana', address: h.attestors[0]!.address }] });
    const holderTok = rig.token({ accountId: 'ex-b2', wallets: [{ chain: 'solana', address: h.backers[2]!.address }], roles: ['backer'] });
    const tx = await h.sim.build({ kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, h.attestors[0]!.address, [h.attestors[1]!.address]);
    const signed = await h.attestors[1]!.coSign(await h.attestors[0]!.sign(tx));
    const r = await rig.post('/tx/send', signed, att1);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().events.map((e: { type: string }) => e.type)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/status`)).json().status).toBe('Extinguished');
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[2]!.address }, holderTok);
    expect(claim.json().claimable).toBe(USDC(900).toString()); // 4,500 unreleased ÷ 5 holders, no fee
    const issuerTok = rig.token({ accountId: 'ex-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).statusCode).toBe(409);
    const sched = await rig.get(`/series/${seriesId}/reporting/schedule`, issuerTok);
    expect(sched.json().status).toBe('Extinguished');
  });

  it('multi-series issuer with tier-1 reconciliation: split receipts reduce the quarterly payment due', async () => {
    const h = rig.sol;
    // tier 1 is a report tier only on a pure tier-1 series (Stage 1)
    const a = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: false, tier3: false, tier4: false } } });
    const b = await h.runRaise({ terms: { unitsOffered: '300' }, bids: [{ backer: 0, price: USDC(15), qty: 60n }, { backer: 1, price: USDC(15), qty: 60n }, { backer: 2, price: USDC(15), qty: 60n }, { backer: 3, price: USDC(15), qty: 60n }, { backer: 4, price: USDC(15), qty: 60n }] });
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId: a.seriesId, router: h.router });
    const issuerTok = rig.token({ accountId: 'ms-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    await rig.sync();
    const me = await rig.get(`/issuers/solana:${h.issuer.address}`);
    expect(me.json().series.length).toBeGreaterThanOrEqual(2);
    const settledAt = (await h.sim.getSeries(a.seriesId))!.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), settledAt + 1));
    await h.sim.postSplitReceipt(h.router, a.seriesId, USDC(1000));
    await rig.sync();
    const splits = await rig.get(`/series/${a.seriesId}/reporting/splits/${q.id}`, issuerTok);
    expect(splits.json().splitReceived).toBe(USDC(1000).toString());
    expect(splits.json().receipts).toHaveLength(1);
    await h.sim.setTime(q.end + 86_400);
    const res = await h.reportAndPay(a.seriesId, q.id, a.privateTerms, a.terms.termsCommitment, 0n, USDC(100_000), { tier: 1, source: 'split' });
    expect(res.due).toBe(USDC(3000));
    await rig.sync();
    const periods = await rig.get(`/series/${a.seriesId}/periods`, issuerTok);
    const p = periods.json().periods.find((x: { periodId: string }) => x.periodId === q.id);
    expect(p).toMatchObject({ splitReceived: USDC(1000).toString(), paid: USDC(3000).toString(), settled: true });
    void b;
  });

  it('transfer window: with the flag on, the keeper opens a window after lockup and clears it; units move within the wallet cap', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const seriesId = raise.seriesId;
    await setFlag(rig.t.pool, 'transfer_windows', true, 'test');
    const sched = new KeeperScheduler(rig.ctx as never, [transferWindowsJob]);
    const now0 = await h.sim.now();
    const q = parsePeriod(`${new Date(now0 * 1000).getUTCFullYear()}Q${Math.floor(new Date(now0 * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(now0 + 11, q.start + 15 * 86_400));
    const r1 = await sched.runAll();
    expect(r1['transfer.windows']!.actions).toBeGreaterThanOrEqual(1);
    await rig.sync();
    const win = (await rig.get(`/series/${seriesId}/window`)).json();
    expect(win.phase).toBe('commit');
    const seller = h.backers[1]!;
    const sellerTok = rig.token({ accountId: 'tw-s', wallets: [{ chain: 'monad', address: seller.address }], roles: ['backer'] });
    const buyer = h.sim.address('wallet:tw-buyer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer, 'USDC', USDC(10_000));
    const buyerTok = rig.token({ accountId: 'tw-b', wallets: [{ chain: 'monad', address: buyer }], roles: ['backer'] });
    const salt = '0x' + 'bb'.repeat(32);
    const sc = orderCommitment({ seriesId, windowId: win.window.windowId, wallet: seller.address, side: 'sell', pricePerUnit: USDC(10), quantity: 40n, salt });
    const bc = orderCommitment({ seriesId, windowId: win.window.windowId, wallet: buyer, side: 'buy', pricePerUnit: USDC(11), quantity: 40n, salt });
    await send(seller, (await rig.post(`/series/${seriesId}/window/build-commit`, { wallet: seller.address, side: 'sell', commitment: sc, deposit: '0', units: '40' }, sellerTok)).json().tx, sellerTok);
    const bcTx = (await rig.post(`/series/${seriesId}/window/build-commit`, { wallet: buyer, side: 'buy', commitment: bc, deposit: USDC(440).toString(), units: '0' }, buyerTok)).json().tx as UnsignedTx;
    expect((await rig.post('/tx/send', { tx: bcTx, signatures: { [buyer]: `sim:${buyer}` } }, buyerTok)).statusCode).toBe(200);
    await h.sim.setTime(win.window.commitEndsAt);
    await send(seller, (await rig.post(`/series/${seriesId}/window/build-reveal`, { wallet: seller.address, side: 'sell', pricePerUnit: USDC(10).toString(), quantity: '40', salt }, sellerTok)).json().tx, sellerTok);
    const brTx = (await rig.post(`/series/${seriesId}/window/build-reveal`, { wallet: buyer, side: 'buy', pricePerUnit: USDC(11).toString(), quantity: '40', salt }, buyerTok)).json().tx as UnsignedTx;
    await rig.post('/tx/send', { tx: brTx, signatures: { [buyer]: `sim:${buyer}` } }, buyerTok);
    await h.sim.setTime(win.window.revealEndsAt);
    const r2 = await sched.runAll();
    expect(r2['transfer.windows']!.actions).toBe(1);
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/window`)).json().window.cleared).toBe(true);
    const holders = await rig.get(`/series/${seriesId}/holders`, sellerTok);
    expect(holders.json().holders.find((x: { wallet: string }) => x.wallet === buyer).units).toBe('40');
    expect(holders.json().holders.find((x: { wallet: string }) => x.wallet === seller.address).units).toBe('60');
    expect((await rig.get(`/series/${seriesId}/activity`)).json().activity.map((a: { summary: string }) => a.summary)).toContain('40 units transferred in window 0');
    await setFlag(rig.t.pool, 'transfer_windows', false, 'test');
  });

  it('FX fallback: a non-USD series with no snapshots is flagged by the keeper; the fx endpoint says an attestor rate is required', async () => {
    const h = rig.sol;
    const raise = await h.runRaise({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'GBP', indexingRule: 'cpi-annual', termsSalt: BigInt('0x' + '99'.repeat(31)) }, terms: { reportingCurrency: 'GBP' } });
    const issuerTok = rig.token({ accountId: 'fx-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const settledAt = (await h.sim.getSeries(raise.seriesId))!.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), q.end + 86_400));
    await rig.sync();
    const r = await new KeeperScheduler(rig.ctx as never, [fxCoverageJob]).runAll();
    expect(r['fx.coverage']!.actions).toBeGreaterThan(0);
    const fx = await rig.get(`/series/${raise.seriesId}/reporting/fx/${q.id}`, issuerTok);
    expect(fx.json()).toMatchObject({ basis: 'attestor', pair: 'GBP/USD' });
    const req = await rig.t.pool.query("select state from fx_fallback_requests where chain = 'solana' and pair = 'GBP/USD' and period_id = $1", [q.id]);
    expect(req.rows[0]!.state).toBe('open');
  });
});

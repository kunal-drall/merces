import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFlag } from '@merces/core';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { makeContext } from '@merces/api';
import { TEMPLATES, createServiceContext, safeData, type ServiceContext } from '@merces/services';
import { MockChainlink, MockPyth } from '@merces/ports';
import { parsePeriod, periodOf, ratePerUnit, wadFromDecimal } from '@merces/math';
import { SimHarness, SimulatorChain } from '@merces/simulator';
import { ChainError, type ChainPort } from '@merces/domain';
import type { ChainRegistry } from '@merces/chains';
import { KeeperScheduler, auctionDeliverJob, auctionSettleJob, deadlineRemindersJob, fxCoverageJob, pauseCrankJob, rateKeeperJob, statusCrankJob, burnCrankJob, outboxJob, transferWindowsJob } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;
const DAY = 86_400;
/*
 * S2 cause codes on the pins that moved:
 *  - S2-MS: Stage 1's multi-step settlement; the keepers settle (`auction.settle`) and deliver (`auction.deliver`) in
 *    separate jobs (was one job, and before S2 the one-step settleAuction).
 */

/** A registry of one chain, for a test that needs its own series ids, reminder ledger or a wrapped port. */
function registryOf(key: string, port: ChainPort): ChainRegistry {
  return { chains: new Map([[key, port]]), decisions: [], stage1: null, get: () => port, byFamily: () => port, close: async () => undefined };
}

describe.skipIf(!dbTestsEnabled())('M4 keepers (E7) and rate keeper (E8)', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  let sol: SimHarness;
  let mon: SimHarness;
  let ctx: ServiceContext;
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
  beforeAll(async () => {
    t = await createTestSchema();
    sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana', genesis: GENESIS, acceptMockProofs: true }) });
    mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad', genesis: GENESIS, acceptMockProofs: true }) });
    const chains: ChainRegistry = { chains: new Map([['solana', sol.sim], ['monad', mon.sim]]), decisions: [], stage1: null, get: (c) => (c === 'solana' ? sol.sim : mon.sim), byFamily: (f) => (f === 'solana' ? sol.sim : mon.sim), close: async () => undefined };
    ctx = createServiceContext(makeContext({ pool: t.pool, chains, log: silent, sessionSecret: 's', devMode: true }));
  });
  afterAll(async () => {
    await t.drop();
  });

  it('status/pause/burn cranks and deadline reminders are idempotent and safe to run late', async () => {
    const a = await sol.runRaise();
    const sched = new KeeperScheduler(ctx, [statusCrankJob, deadlineRemindersJob, pauseCrankJob, burnCrankJob]);
    // 46 days after Q1 end: Late; reminders for due-soon, due and grace-end all fire exactly once even though the keeper was late
    await sol.sim.setTime(parsePeriod('2026Q1').end + 46 * 86_400);
    await mon.sim.setTime(parsePeriod('2026Q1').end + 46 * 86_400);
    const r1 = await sched.runAll();
    expect(r1['status.crank']!.actions).toBe(1);
    expect(r1['reporting.reminders']!.actions).toBe(3);
    expect((await sol.sim.getSeries(a.seriesId))!.status).toBe('Late');
    const r2 = await sched.runAll();
    expect(r2['status.crank']!.actions).toBe(0);
    expect(r2['reporting.reminders']!.actions).toBe(0);
    const runs = await t.pool.query("select job, ok, actions from keeper_runs order by id");
    expect(runs.rows.length).toBe(8);
    expect(runs.rows.every((r) => r.ok)).toBe(true);
    // pay, then a hardship pause that the crank ends when due
    await sol.reportAndPay(a.seriesId, '2026Q1', a.privateTerms, a.terms.termsCommitment, 0n, USDC(10_000));
    const until = (await sol.sim.now()) + 30 * 86_400;
    await sol.exec(sol.issuer, { kind: 'requestPause', seriesId: a.seriesId, until });
    await sol.exec(sol.attestors[0]!, { kind: 'approvePause', seriesId: a.seriesId, until });
    expect((await sched.runAll())['pause.crank']!.actions).toBe(0);
    await sol.sim.setTime(until + 1);
    expect((await sched.runAll())['pause.crank']!.actions).toBe(1);
    expect((await sol.sim.getSeries(a.seriesId))!.status).toBe('OnTime');
    // cap hit → retired → burn crank burns unclaimed holders (idempotent)
    await sol.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    await sol.reportAndPay(a.seriesId, '2026Q2', a.privateTerms, a.terms.termsCommitment, USDC(10_000), USDC(10_000));
    await sol.reportAndPay(a.seriesId, '2026Q3', a.privateTerms, a.terms.termsCommitment, USDC(10_000), USDC(500_000));
    expect((await sol.sim.getSeries(a.seriesId))!.status).toBe('Retired');
    expect((await sched.runAll())['burn.crank']!.actions).toBe(5);
    expect((await sched.runAll())['burn.crank']!.actions).toBe(0);
    expect((await sol.sim.getSeries(a.seriesId))!.unitsOutstanding).toBe('0');
    // holders still claim after the burn
    const c = await sol.exec(sol.backers[0]!, { kind: 'claimPayout', seriesId: a.seriesId });
    expect(BigInt((c.events[0]!.payload as { amount: string }).amount)).toBeGreaterThan(0n);
  });

  it('rate keeper snapshots once per day per pair per chain, resolves feed ids, cross-checks Chainlink and flags deviation', async () => {
    const eur = await mon.runRaise({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'EUR', indexingRule: 'cpi-annual', termsSalt: BigInt('0x' + '66'.repeat(31)) }, terms: { reportingCurrency: 'EUR' } });
    const pyth = new MockPyth({ 'FX.EUR/USD': { price: '1.08' }, 'FX.USD/INR': { price: '83.5' } }, () => mon.sim.clock.now());
    const chainlink = new MockChainlink({ 'monad:EUR/USD': { answer: '1.0805', decimals: 8 } });
    const job = rateKeeperJob({ pyth, chainlink, deviationBandBps: 100 });
    await t.pool.query("insert into rate_pairs (chain, pair) values ('monad', 'INR/USD'), ('monad', 'JPY/USD')");
    const sched = new KeeperScheduler(ctx, [job]);
    const r1 = await sched.runAll();
    // EUR (from the live series) and INR snapshot; JPY has no feed → fails closed with an error recorded
    expect(r1['rate.snapshot']!.actions).toBe(2);
    expect(r1['rate.snapshot']!.detail).toContain('no Pyth feed for FX.USD/JPY');
    expect(r1['rate.snapshot']!.ok).toBe(false); // a missing feed is a failure to alert on, not a routine skip
    const pairs = await t.pool.query("select pair, pyth_feed_id, last_error from rate_pairs where chain = 'monad' order by pair");
    expect(pairs.rows.find((p) => p.pair === 'EUR/USD').pyth_feed_id).toBe('0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b');
    expect(pairs.rows.find((p) => p.pair === 'JPY/USD').last_error).toContain('failing closed');
    const acc = await mon.sim.getRateAccumulator('EUR/USD');
    expect(acc!.count).toBe(1);
    expect(acc!.lastRateWad).toBe(wadFromDecimal('1.08').toString());
    const inr = await mon.sim.getRateAccumulator('INR/USD');
    expect(BigInt(inr!.lastRateWad!)).toBe(10n ** 36n / wadFromDecimal('83.5')); // inverted EM quote
    // same day: nothing more
    expect((await sched.runAll())['rate.snapshot']!.actions).toBe(0);
    // next day: one more each; a cross-check row is recorded within the band
    await mon.sim.advanceTime(86_400);
    expect((await sched.runAll())['rate.snapshot']!.actions).toBe(2);
    const checks = await t.pool.query("select within_band, deviation_bps from fx_cross_checks where pair = 'EUR/USD' order by day_index");
    expect(checks.rows.map((c) => c.within_band)).toEqual([true, true]);
    expect(checks.rows[0]!.deviation_bps).toBeLessThan(10);
    // deviation beyond the band: no snapshot, quarter flagged, attestor request opened
    chainlink.feeds['monad:EUR/USD'] = { answer: '1.20', decimals: 8 };
    await mon.sim.advanceTime(86_400);
    const r3 = await sched.runAll();
    expect(r3['rate.snapshot']!.detail).toContain('deviation');
    expect((await mon.sim.getRateAccumulator('EUR/USD'))!.count).toBe(2);
    const req = await t.pool.query("select pair, reason, state from fx_fallback_requests where chain = 'monad'");
    expect(req.rows).toContainEqual({ pair: 'EUR/USD', reason: 'deviation', state: 'open' });
    // stale price (market closed): fails closed
    chainlink.feeds['monad:EUR/USD'] = { answer: '1.08', decimals: 8 };
    const stalePyth = new MockPyth({ 'FX.EUR/USD': { price: '1.08' } }, () => mon.sim.clock.now() - 2 * 86_400);
    await mon.sim.advanceTime(86_400);
    const r4 = await new KeeperScheduler(ctx, [rateKeeperJob({ pyth: stalePyth, chainlink })]).runAll();
    expect(r4['rate.snapshot']!.detail).toContain('stale');
    // a closed FX market is routine, not a failure (the JPY pair without a feed still is one)
    expect(r4['rate.snapshot']!.detail!.split('errors:')[1] ?? '').not.toContain('stale');
    void eur;
  });

  it('fx coverage flags a completed quarter with too few snapshots and routes it to attestors; outbox dispatches once', async () => {
    const sched = new KeeperScheduler(ctx, [fxCoverageJob]);
    await mon.sim.setTime(parsePeriod('2026Q4').end + 86_400);
    const r = await sched.runAll();
    expect(r['fx.coverage']!.actions).toBeGreaterThan(0);
    const q = await mon.sim.getQuarterRate('EUR/USD', '2026Q4');
    expect(q!.needsFallback).toBe(true);
    const reqs = await t.pool.query("select period_id, reason from fx_fallback_requests where chain = 'monad' and pair = 'EUR/USD' order by period_id");
    expect(reqs.rows.map((x) => x.period_id)).toContain('2026Q4');
    expect((await sched.runAll())['fx.coverage']!.actions).toBe(0);
    const seen: string[] = [];
    const ob = new KeeperScheduler(ctx, [outboxJob(async (_t, p) => { seen.push(String(p.kind)); })]);
    const first = await ob.runAll();
    expect(first['outbox.dispatch']!.actions).toBeGreaterThan(0);
    expect(seen).toContain('fx.fallback-needed');
    expect((await ob.runAll())['outbox.dispatch']!.actions).toBe(0);
  });

  it('a chain outage or an unexpected submit error marks the run failed instead of passing silently; other chains still run', async () => {
    const a = await mon.runRaise();
    // the shared simulator clock has moved on in earlier tests: go 31 days past the end of the current quarter
    await mon.sim.setTime(periodOf(await mon.sim.now()).end + 31 * 86_400);
    const broken = { chain: 'broken', mode: 'mock', now: async () => { throw new Error('rpc 503'); }, listSeries: async () => [] } as never;
    const reg2: ChainRegistry = { chains: new Map([['broken', broken], ['monad', mon.sim]]), decisions: [], stage1: null, get: (c) => (c === 'monad' ? mon.sim : broken), byFamily: () => mon.sim, close: async () => undefined };
    const ctx2 = createServiceContext(makeContext({ pool: t.pool, chains: reg2, log: silent, sessionSecret: 's', devMode: true }));
    const out = await new KeeperScheduler(ctx2, [statusCrankJob]).runAll();
    expect(out['status.crank']!.ok).toBe(false);
    expect(out['status.crank']!.detail).toMatch(/broken: rpc 503/);
    expect(out['status.crank']!.actions).toBeGreaterThanOrEqual(1); // monad was still cranked
    expect((await mon.sim.getSeries(a.seriesId))!.status).not.toBe('OnTime');
    const row = await t.pool.query("select ok, detail from keeper_runs where job = 'status.crank' order by id desc limit 1");
    expect(row.rows[0]).toMatchObject({ ok: false });
    // an unexpected error from submit (not a 'nothing to do' refusal) is surfaced too
    const flaky = new Proxy(mon.sim, { get(target, k) { if (k === 'submit') return async () => { throw new Error('fee payer out of funds'); }; const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v; } });
    const reg3: ChainRegistry = { ...reg2, chains: new Map([['monad', flaky as never]]) };
    const ctx3 = createServiceContext(makeContext({ pool: t.pool, chains: reg3, log: silent, sessionSecret: 's', devMode: true }));
    await mon.sim.setTime(periodOf(await mon.sim.now()).end + 50 * 86_400);
    const out3 = await new KeeperScheduler(ctx3, [statusCrankJob]).runAll();
    expect(out3['status.crank']!.ok).toBe(false);
    expect(out3['status.crank']!.detail).toMatch(/fee payer out of funds/);
  });

  // cause S2-MS: the settle job drives Stage 1's steps (was the one-step settleAuction) and leaves delivery to the deliver
  // job (was: both in one job); their errors are value-free (S2 L7)
  it('the settle job takes a due raise to mint finalisation in Stage 1\'s steps and the deliver job delivers it; a failure names the series and a code, never a message', async () => {
    const a = await sol.runRaise({ settle: 'none' });
    const out = await new KeeperScheduler(ctx, [auctionSettleJob]).runAll();
    // the proposal, one tally page, finalize, then a process for each of the five bids (cause S2-MS: was 13 steps with
    // a delivery each)
    expect(out['auction.settle']).toMatchObject({ ok: true, actions: 8 });
    expect(await sol.sim.getAuction(a.seriesId)).toMatchObject({ raiseState: 'Settled', mintFinalized: true, bidsProcessed: 5 });
    expect((await sol.sim.listBids(a.seriesId)).map((b) => [b.processed, b.delivered])).toEqual(Array(5).fill([true, false]));
    expect((await new KeeperScheduler(ctx, [auctionSettleJob]).runAll())['auction.settle']).toMatchObject({ ok: true, actions: 0 });
    // the deliver job pushes every processed bid: the refunds and the units
    expect((await new KeeperScheduler(ctx, [auctionDeliverJob]).runAll())['auction.deliver']).toMatchObject({ ok: true, actions: 5 });
    expect((await sol.sim.listBids(a.seriesId)).every((b) => b.delivered && b.pendingRefund === '0' && b.pendingUnits === '0')).toBe(true);
    expect((await new KeeperScheduler(ctx, [auctionDeliverJob]).runAll())['auction.deliver']).toMatchObject({ ok: true, actions: 0 });
    // a submit refused with an amount in its message: the run fails with the series and the Stage 1 name only
    const b = await mon.runRaise({ settle: 'none' });
    const flaky = new Proxy(mon.sim, { get(target, k) { if (k === 'submit') return async () => { throw new ChainError('InsufficientFunds', 'fee payer is short by 123456789', { stage1: 'InsufficientEscrow' }); }; const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v; } });
    const reg: ChainRegistry = { chains: new Map([['monad', flaky as never]]), decisions: [], stage1: null, get: () => flaky as never, byFamily: () => flaky as never, close: async () => undefined };
    const out2 = await new KeeperScheduler(createServiceContext(makeContext({ pool: t.pool, chains: reg, log: silent, sessionSecret: 's', devMode: true })), [auctionSettleJob]).runAll();
    expect(out2['auction.settle']).toMatchObject({ ok: false, actions: 0, detail: `errors: ${b.seriesId}: InsufficientEscrow` });
    expect(out2['auction.settle']!.detail).not.toContain('123456789');
    expect((await mon.sim.getAuction(b.seriesId))!.raiseState).toBe('Open');
    await mon.settle(b.seriesId, 'deliver');
  });

  it('a settlement the planner will not act on fails each settle run with its reason and tells the admins once', async () => {
    const key = 'solana-settle-stuck';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    // the chain reports one more valid bid than its bids show: the planner refuses to propose (ValidityMismatch)
    const port = new Proxy(h.sim, {
      get(target, k) {
        if (k === 'getAuction') return async (id: string) => { const a = await target.getAuction(id); return a && { ...a, validCount: a.validCount + 1 }; };
        const v = Reflect.get(target, k);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const c = createServiceContext(makeContext({ pool: t.pool, chains: registryOf(key, port as never), log: silent, sessionSecret: 's', devMode: true }));
    const { seriesId } = await h.runRaise({ settle: 'none' });
    const job = new KeeperScheduler(c, [auctionSettleJob]);
    for (let i = 0; i < 2; i++) expect((await job.runAll())['auction.settle']).toMatchObject({ ok: false, actions: 0, detail: `errors: ${seriesId}: stuck (ValidityMismatch)` });
    const alerts = await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'kind' = 'auction.settlement-stuck' and payload->>'seriesId' = $1", [seriesId]);
    expect(alerts.rows.map((r) => r.payload)).toEqual([{ kind: 'auction.settlement-stuck', seriesId, outcome: 'ValidityMismatch' }]);
    expect((await h.sim.getAuction(seriesId))!.raiseState).toBe('Open');
  });

  it('the deliver job retries a refused delivery on its own backoff, delivers every other bid, and reports one still failing a day after finalization once', async () => {
    const key = 'monad-deliveries';
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    // the chain refuses one bidder's delivery (say its token account is gone), with a value in the message
    let refused: string | null = null;
    const port = new Proxy(h.sim, {
      get(target, k) {
        if (k === 'submit') {
          return async (...args: Parameters<typeof target.submit>) => {
            const cmd = args[0];
            if (cmd.kind === 'deliverBid' && cmd.bidder === refused) throw new ChainError('ChainSpecific', 'token account missing; rent 2039280 short');
            return target.submit(...args);
          };
        }
        const v = Reflect.get(target, k);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const c = createServiceContext(makeContext({ pool: t.pool, chains: registryOf(key, port as never), log: silent, sessionSecret: 's', devMode: true }));
    const settle = new KeeperScheduler(c, [auctionSettleJob]);
    const deliver = new KeeperScheduler(c, [auctionDeliverJob]);
    const a = await h.runRaise({ settle: 'none' });
    const stuckBidder = h.backers[2]!.address;
    refused = stuckBidder;
    expect((await settle.runAll())['auction.settle']).toMatchObject({ ok: true, actions: 8 });
    const { finalizedAt } = (await h.sim.getAuction(a.seriesId))!;
    const record = async () => (await t.pool.query<{ attempts: number; next_at: string; last_error: string; notified: boolean }>('select attempts, extract(epoch from next_attempt_at)::bigint::text as next_at, last_error, stuck_notified_at is not null as notified from auction_deliveries where series_id = $1', [a.seriesId])).rows;
    const stuckNotices = async () => (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'kind' = 'bid.delivery-stuck' and payload->>'seriesId' = $1", [a.seriesId])).rows.map((r) => r.payload);
    // the four others are delivered; the refusal is recorded with its code and a one-minute backoff (chain time)
    const t0 = await h.sim.now();
    const r1 = (await deliver.runAll())['auction.deliver']!;
    expect(r1).toMatchObject({ ok: false, actions: 4, detail: `errors: ${a.seriesId} ${stuckBidder}: ChainSpecific (attempt 1)` });
    expect((await h.sim.listBids(a.seriesId)).filter((b) => !b.delivered).map((b) => b.bidder)).toEqual([stuckBidder]);
    expect(await record()).toEqual([{ attempts: 1, next_at: String(t0 + 60), last_error: 'ChainSpecific', notified: false }]);
    // inside the backoff nothing is attempted, and the run is not a failure
    expect((await deliver.runAll())['auction.deliver']).toMatchObject({ ok: true, actions: 0, detail: '1 waiting' });
    expect((await record())[0]!.attempts).toBe(1);
    // the next attempts wait 5 min, 30 min, 2 h, 12 h, then a day
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { next_at } = (await record())[0]!;
      await h.sim.setTime(Number(next_at));
      expect((await deliver.runAll())['auction.deliver']).toMatchObject({ ok: false, actions: 0 });
      waits.push(Number((await record())[0]!.next_at) - Number(next_at));
    }
    expect(waits).toEqual([300, 1_800, 7_200, 43_200, DAY, DAY]);
    expect((await record())[0]).toMatchObject({ attempts: 7, last_error: 'ChainSpecific' });
    // a day after finalization, once a delivery has failed: one bid.delivery-stuck to the admins and the bidder
    expect((await h.sim.now()) >= finalizedAt! + DAY).toBe(true);
    expect(await stuckNotices()).toEqual([{ kind: 'bid.delivery-stuck', seriesId: a.seriesId, wallet: stuckBidder }]);
    expect((await record())[0]!.notified).toBe(true);
    await h.sim.setTime(Number((await record())[0]!.next_at));
    expect((await deliver.runAll())['auction.deliver']).toMatchObject({ ok: false, actions: 0 });
    expect(await stuckNotices()).toHaveLength(1);
    // never a message: neither the record nor the runs carry the adapter's text
    const runs = await t.pool.query("select detail from keeper_runs where job = 'auction.deliver' and detail is not null");
    expect(JSON.stringify([runs.rows, await record()])).not.toMatch(/2039280|token account/);
    // the chain takes it again: delivered on the next due attempt, and the record goes
    refused = null;
    await h.sim.setTime(Number((await record())[0]!.next_at));
    expect((await deliver.runAll())['auction.deliver']).toMatchObject({ ok: true, actions: 1 });
    expect((await h.sim.listBids(a.seriesId)).every((b) => b.delivered)).toBe(true);
    expect(await record()).toEqual([]);
  });

  it('a bid delivered by someone else is not a keeper failure: a lost race and a recorded bid delivered since both clear', async () => {
    const key = 'solana-delivery-race';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    let refused: string | null = null;
    let raced: string | null = null;
    const port = new Proxy(h.sim, {
      get(target, k) {
        if (k === 'submit') {
          return async (...args: Parameters<typeof target.submit>) => {
            const cmd = args[0];
            if (cmd.kind === 'deliverBid' && cmd.bidder === refused) throw new ChainError('ChainSpecific', 'refused');
            // the bidder's own delivery lands between the keeper's read and its send
            if (cmd.kind === 'deliverBid' && cmd.bidder === raced) await h.exec(h.backers.find((w) => w.address === raced)!, { kind: 'deliverBid', seriesId: cmd.seriesId, bidder: cmd.bidder });
            return target.submit(...args);
          };
        }
        const v = Reflect.get(target, k);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const c = createServiceContext(makeContext({ pool: t.pool, chains: registryOf(key, port as never), log: silent, sessionSecret: 's', devMode: true }));
    const a = await h.runRaise({ settle: 'process' });
    refused = h.backers[0]!.address;
    raced = h.backers[1]!.address;
    const r1 = (await new KeeperScheduler(c, [auctionDeliverJob]).runAll())['auction.deliver']!;
    // backer 1's delivery was refused AlreadyDelivered (its own got in first): neither an error nor a record
    expect(r1).toMatchObject({ ok: false, actions: 3, detail: `errors: ${a.seriesId} ${refused}: ChainSpecific (attempt 1)` });
    expect((await t.pool.query('select bidder from auction_deliveries where series_id = $1', [a.seriesId])).rows).toEqual([{ bidder: refused }]);
    // backer 0 delivers itself while the keeper waits out its backoff: the record is dropped on the next pass
    await h.exec(h.backers[0]!, { kind: 'deliverBid', seriesId: a.seriesId, bidder: refused });
    expect((await new KeeperScheduler(c, [auctionDeliverJob]).runAll())['auction.deliver']).toMatchObject({ ok: true, actions: 0 });
    expect((await t.pool.query('select 1 from auction_deliveries where series_id = $1', [a.seriesId])).rowCount).toBe(0);
    expect((await h.sim.listBids(a.seriesId)).every((b) => b.delivered)).toBe(true);
  });

  it('the transfer-windows job leaves a series still processing its bids alone (MintNotFinalized), then opens its window', async () => {
    const key = 'solana-windows-mint';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const c = createServiceContext(makeContext({ pool: t.pool, chains: registryOf(key, h.sim), log: silent, sessionSecret: 's', devMode: true }));
    const a = await h.runRaise({ settle: 'finalize', terms: { lockupSeconds: 10 } });
    await setFlag(t.pool, 'transfer_windows', true, 'test');
    try {
      const q = periodOf(await h.sim.now());
      await h.sim.setTime(q.start + 15 * DAY);
      const s = (await h.sim.getSeries(a.seriesId))!;
      expect([s.phase, s.mintFinalized, (await h.sim.now()) >= s.lockupEndsAt!]).toEqual(['Settled', false, true]);
      // the chain would refuse the window (MintNotFinalized): the job does not try, and the run is clean
      await expect(h.sim.submit({ kind: 'openTransferWindow', seriesId: a.seriesId, commitEndsAt: (await h.sim.now()) + 7 * DAY, revealEndsAt: (await h.sim.now()) + 9 * DAY }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'MintNotFinalized' } });
      const job = new KeeperScheduler(c, [transferWindowsJob]);
      expect((await job.runAll())['transfer.windows']).toMatchObject({ ok: true, actions: 0 });
      expect(await h.sim.getTransferWindow(a.seriesId)).toBeNull();
      // once the last bid is processed the window opens
      await h.settle(a.seriesId, 'process');
      expect((await job.runAll())['transfer.windows']).toMatchObject({ ok: true, actions: 1 });
      expect(await h.sim.getTransferWindow(a.seriesId)).not.toBeNull();
    } finally {
      await setFlag(t.pool, 'transfer_windows', false, 'test');
    }
  });

  it('reminders and the status crank follow Stage 1\'s instants: InGrace after dueAt, Late after graceEndsAt, formal notice at formalNoticeAt', async () => {
    // a chain of its own, so the series id and the reminder ledger are fresh
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad-instants', genesis: GENESIS, acceptMockProofs: true }) });
    const reg: ChainRegistry = { chains: new Map([['monad-instants', h.sim]]), decisions: [], stage1: null, get: () => h.sim, byFamily: () => h.sim, close: async () => undefined };
    const c = createServiceContext(makeContext({ pool: t.pool, chains: reg, log: silent, sessionSecret: 's', devMode: true }));
    const a = await h.runRaise();
    const q = periodOf((await h.sim.getSeries(a.seriesId))!.settledAt!);
    const p = (await h.sim.getPeriod(a.seriesId, q.id))!;
    // Stage 1's countdown runs from the period end; OnTime while ≤ 30 days, InGrace while ≤ 45 days (cause G2: both bounds
    // inclusive, REF status.ts:67-68), the formal notice at 90 days (cause N: Stage 1 formalNoticeDue is period end + 90
    // days; was due date + 90 = period end + 120 days)
    expect([p.dueAt, p.graceEndsAt, p.formalNoticeAt]).toEqual([q.end + 30 * 86_400, q.end + 45 * 86_400, q.end + 90 * 86_400]);
    const sched = new KeeperScheduler(c, [statusCrankJob, deadlineRemindersJob]);
    const step = async (at: number) => {
      await h.sim.setTime(at);
      const r = await sched.runAll();
      return [r['status.crank']!.actions, r['reporting.reminders']!.actions, (await h.sim.getSeries(a.seriesId))!.status];
    };
    const sent = async () => (await t.pool.query('select kind from reminders_sent where target = $1 order by kind', [`${a.seriesId}:${q.id}`])).rows.map((r) => r.kind);
    // exactly 30 days: still OnTime, nothing to crank; only the due-soon reminder (G2: 'report-due' went out at dueAt,
    // with the crank recording InGrace)
    expect(await step(p.dueAt)).toEqual([0, 1, 'OnTime']);
    expect(await sent()).toEqual(['report-due-soon']);
    // one second later: InGrace is recorded and the issuer told
    expect(await step(p.dueAt + 1)).toEqual([1, 1, 'InGrace']);
    expect(await sent()).toEqual(['report-due', 'report-due-soon']);
    expect(await step(p.graceEndsAt)).toEqual([0, 0, 'InGrace']); // exactly 45 days: still InGrace (G2; was Late)
    expect(await step(p.graceEndsAt + 1)).toEqual([1, 1, 'Late']);
    expect(await sent()).toEqual(['grace-end', 'report-due', 'report-due-soon']);
    // the formal notice is recorded at period end + 90 days, once (cause N; was at period end + 120 days)
    expect(await step(p.formalNoticeAt - 1)).toEqual([0, 0, 'Late']);
    expect((await h.sim.getSeries(a.seriesId))!.formalNoticeEmittedFor).toBeNull();
    expect(await step(p.formalNoticeAt)).toEqual([1, 0, 'Late']);
    expect((await h.sim.getSeries(a.seriesId))!.formalNoticeEmittedFor).toBe(q.id);
    expect(await step(p.formalNoticeAt + 3600)).toEqual([0, 0, 'Late']);
    // the reminders carry the chain's instants, what is outstanding and the status the chain derived when each was queued
    const notes = await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'seriesId' = $1 and payload->>'kind' like 'reporting.%' order by id", [a.seriesId]);
    expect(notes.rows.map((r) => [r.payload.kind, r.payload.dueAt, r.payload.graceEndsAt, r.payload.outstanding, r.payload.status])).toEqual([
      ['reporting.report-due-soon', p.dueAt, p.graceEndsAt, 'report', 'OnTime'], ['reporting.report-due', p.dueAt, p.graceEndsAt, 'report', 'InGrace'], ['reporting.grace-end', p.dueAt, p.graceEndsAt, 'report', 'Late'],
    ]);
  });

  it('reminders follow the earliest unpaid period, as Stage 1 derives status: a later period waits, and a notice names the chain\'s status and what is owed', async () => {
    // S1 review: the job reminded every unsettled period with a status assumed from that period's own deadline, so an
    // issuer whose unpaid Q1 kept the series Late was told 'Status: InGrace' about a Q2 report the chain could not take
    for (const personality of ['solana', 'monad'] as const) {
      const key = `${personality}-earliest-unpaid`;
      const h = await SimHarness.create(personality, { sim: SimulatorChain.createSync({ personality, chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
      const reg: ChainRegistry = { chains: new Map([[key, h.sim]]), decisions: [], stage1: null, get: () => h.sim, byFamily: () => h.sim, close: async () => undefined };
      const c = createServiceContext(makeContext({ pool: t.pool, chains: reg, log: silent, sessionSecret: 's', devMode: true }));
      const a = await h.runRaise();
      const q1 = periodOf((await h.sim.getSeries(a.seriesId))!.settledAt!);
      const q2 = periodOf(q1.end + 86_400);
      const sched = new KeeperScheduler(c, [statusCrankJob, deadlineRemindersJob]);
      const notices = async () => (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'seriesId' = $1 and payload->>'kind' like 'reporting.%' order by id", [a.seriesId])).rows.map((r) => r.payload as Record<string, unknown>);
      const render = (n: Record<string, unknown>) => TEMPLATES[String(n.kind)]!(safeData(n));
      // the issuer reports Q1 five days after its end and never pays: Q1 holds the open due, so Q1 alone drives the status
      await h.sim.setTime(q1.end + 5 * 86_400);
      await h.exec(h.issuer, (await h.buildReport({ seriesId: a.seriesId, periodId: q1.id, privateTerms: a.privateTerms, termsCommitment: a.terms.termsCommitment, incomeYtdPrev: 0n, incomeYtdNow: USDC(100_000) })).command);
      const rep = (await h.sim.getSeries(a.seriesId))!.reporting;
      expect([rep.openDuePeriod, BigInt(rep.openDueAmount) > 0n, rep.nextExpectedPeriod]).toEqual([q1.id, true, q2.id]);
      const p1 = (await h.sim.getPeriod(a.seriesId, q1.id))!;
      const p2 = (await h.sim.getPeriod(a.seriesId, q2.id))!;
      const statuses: string[] = [];
      for (const at of [p1.dueAt - 7 * 86_400, p1.dueAt + 1, p1.graceEndsAt + 1, p2.dueAt - 7 * 86_400, p2.dueAt + 1, p2.graceEndsAt + 1]) {
        await h.sim.setTime(at);
        expect((await sched.runAll())['reporting.reminders']!.ok).toBe(true);
        statuses.push((await h.sim.getSeries(a.seriesId))!.status);
      }
      expect(statuses).toEqual(['OnTime', 'InGrace', 'Late', 'Late', 'Late', 'Late']);
      // Q2's own deadlines passed, but Q2 is not the earliest unpaid period: the chain still refuses its report and the
      // issuer hears nothing about it; Q1's reminders say the payment is owed and name the status the chain derived
      await expect(h.buildReport({ seriesId: a.seriesId, periodId: q2.id, privateTerms: a.privateTerms, termsCommitment: a.terms.termsCommitment, incomeYtdPrev: 0n, incomeYtdNow: USDC(200_000) }).then((r) => h.exec(h.issuer, r.command))).rejects.toThrow(/not paid/);
      expect((await t.pool.query('select kind from reminders_sent where target = $1', [`${a.seriesId}:${q2.id}`])).rows).toEqual([]);
      const q1Notes = await notices();
      expect(q1Notes.map((n) => [n.kind, n.periodId, n.outstanding, n.status])).toEqual([
        ['reporting.report-due-soon', q1.id, 'payment', 'OnTime'], ['reporting.report-due', q1.id, 'payment', 'InGrace'], ['reporting.grace-end', q1.id, 'payment', 'Late'],
      ]);
      expect(q1Notes.map((n) => render(n).subject)).toEqual(['Payment due soon', 'Payment due', 'Grace period ended']);
      expect(render(q1Notes[1]!).body).toContain(`The payment for series ${a.seriesId}, period ${q1.id} was due by`);
      expect(render(q1Notes[1]!).body).toMatch(/Status: InGrace\.$/);
      expect(render(q1Notes[2]!).body).toMatch(/Status: Late\.$/);
      // once Q1 is paid, Q2 is the earliest unpaid period and its countdown is past 45 days: the series is Late and the
      // late keeper's Q2 reminders all say so (none claims InGrace), asking for the report
      await h.sim.setTime(p2.graceEndsAt + 2 * 86_400);
      const live = (await h.sim.getPeriod(a.seriesId, q1.id))!;
      await h.exec(h.issuer, { kind: 'payIn', seriesId: a.seriesId, periodId: q1.id, amount: (BigInt(live.paymentDue) - BigInt(live.paid)).toString() });
      expect((await sched.runAll())['reporting.reminders']!.actions).toBe(3);
      expect((await h.sim.getSeries(a.seriesId))!.status).toBe('Late');
      const q2Notes = (await notices()).slice(3);
      expect(q2Notes.map((n) => [n.kind, n.periodId, n.outstanding, n.status])).toEqual([
        ['reporting.report-due-soon', q2.id, 'report', 'Late'], ['reporting.report-due', q2.id, 'report', 'Late'], ['reporting.grace-end', q2.id, 'report', 'Late'],
      ]);
      const due = render(q2Notes[1]!);
      expect(due.subject).toBe('Report due');
      expect(due.body).toMatch(/Status: Late\.$/);
      expect(q2Notes.map((n) => render(n).body).join(' ')).not.toContain('InGrace');
      expect((await sched.runAll())['reporting.reminders']!.actions).toBe(0);
    }
  });
});

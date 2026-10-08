import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { makeContext } from '@merces/api';
import { createServiceContext, type ServiceContext } from '@merces/services';
import { MockChainlink, MockPyth } from '@merces/ports';
import { parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, SimulatorChain } from '@merces/simulator';
import type { ChainRegistry } from '@merces/chains';
import { KeeperScheduler, deadlineRemindersJob, fxCoverageJob, pauseCrankJob, rateKeeperJob, statusCrankJob, burnCrankJob, outboxJob } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;

describe.skipIf(!dbTestsEnabled())('M4 keepers (E7) and rate keeper (E8)', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  let sol: SimHarness;
  let mon: SimHarness;
  let ctx: ServiceContext;
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
  beforeAll(async () => {
    t = await createTestSchema();
    sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana', genesis: GENESIS }) });
    mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad', genesis: GENESIS }) });
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
    const eur = await mon.runRaise({ privateTerms: { threshold: 50_000_000_000n, shareRateWad: wadFromDecimal('0.10'), reportingCurrency: 'EUR', indexingRule: 'cpi-annual', salt: '0x' + '66'.repeat(32) }, terms: { reportingCurrency: 'EUR' } });
    const pyth = new MockPyth({ 'FX.EUR/USD': { price: '1.08' }, 'FX.USD/INR': { price: '83.5' } }, () => mon.sim.clock.now());
    const chainlink = new MockChainlink({ 'monad:EUR/USD': { answer: '1.0805', decimals: 8 } });
    const job = rateKeeperJob({ pyth, chainlink, deviationBandBps: 100 });
    await t.pool.query("insert into rate_pairs (chain, pair) values ('monad', 'INR/USD'), ('monad', 'JPY/USD')");
    const sched = new KeeperScheduler(ctx, [job]);
    const r1 = await sched.runAll();
    // EUR (from the live series) and INR snapshot; JPY has no feed → fails closed with an error recorded
    expect(r1['rate.snapshot']!.actions).toBe(2);
    expect(r1['rate.snapshot']!.detail).toContain('no Pyth feed for FX.USD/JPY');
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
});

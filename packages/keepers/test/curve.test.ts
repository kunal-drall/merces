import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { makeContext } from '@merces/api';
import { IdentityService, TEMPLATES, createServiceContext, safeData, type ServiceContext } from '@merces/services';
import { periodOf, periodOfPid } from '@merces/math';
import { SimHarness, SimWallet, SimulatorChain } from '@merces/simulator';
import { ChainError, type ChainPort, type SeriesState } from '@merces/domain';
import type { ChainRegistry } from '@merces/chains';
import { CURVE_SYNC_MARGIN_SECONDS, KeeperScheduler, curveLifecycleJob, curveStakeRemindersJob, curveSyncDue, curveSyncJob, curveTenderRemindersJob, type KeeperJob } from '../src/index.ts';

/*
 * S3 WP11: the curve keepers (cause S3-KP) on Stage 1's curve lifecycle (Solana curve.rs; the simulator's stand-in pool,
 * Stage 1's worked series: 100 units, X = 1,000 USDC, P0 = 10 USDC, a 1% trading fee):
 *  - `curve.lifecycle` completes a filled curve and collects its proceeds once, and the partner's trading fees weekly on
 *    the chain's clock; a step someone else took is skipped; failures are codes;
 *  - `curve.sync` takes the census once after completion and once per period end (plus a margin), never on a terminal
 *    series and never while the issuer's assembled report binds the census (amendment H1);
 *  - `curve.stake-reminders` and `curve.tender-reminders` remind linked wallets holding units in their wallets, with
 *    their next step and no amount (amendment M8).
 */

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;
const DAY = 86_400;

/** A registry of one chain, for a test with its own series ids and reminder ledger, or a wrapped port. */
function registryOf(key: string, port: ChainPort): ChainRegistry {
  return { chains: new Map([[key, port]]), decisions: [], stage1: null, get: () => port, byFamily: () => port, close: async () => undefined };
}

/** `port` with `submit` (or a read) replaced. */
function wrap<K extends keyof ChainPort>(port: ChainPort, k: K, fn: ChainPort[K]): ChainPort {
  return new Proxy(port, {
    get(target, key) {
      if (key === k) return fn;
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe.skipIf(!dbTestsEnabled())('S3 WP11 curve keepers', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
  beforeAll(async () => {
    t = await createTestSchema();
  });
  afterAll(async () => {
    await t.drop();
  });

  const ctxOf = (key: string, port: ChainPort): ServiceContext => createServiceContext(makeContext({ pool: t.pool, chains: registryOf(key, port), log: silent, sessionSecret: 's', devMode: true }));
  const runner = (c: ServiceContext, job: KeeperJob) => async () => (await new KeeperScheduler(c, [job]).runAll())[job.name]!;
  const solana = (key: string) => SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });

  /** A curve series filled by `buys` ([wallet, USDC in]); the last buy fills it. Not completed. */
  async function curveFilledBy(h: SimHarness, buys: [SimWallet, number][]): Promise<string> {
    const { seriesId } = await h.createCurve();
    for (const [w, amount] of buys) await h.curveBuy(seriesId, w, USDC(amount));
    expect((await h.sim.getCurve(seriesId))!.poolComplete).toBe(true);
    return seriesId;
  }

  it('curve.lifecycle collects trading fees at most weekly, completes a filled curve and collects its proceeds once; each check that acted or read a change is recorded with the chain time', async () => {
    const key = 'curve-life';
    const h = await solana(key);
    const c = ctxOf(key, h.sim);
    const run = runner(c, curveLifecycleJob);
    const [a, b, d] = h.backers as [SimWallet, SimWallet, SimWallet];
    const { seriesId } = await h.createCurve();
    const curve = async () => (await h.sim.getCurve(seriesId))!;
    // nothing traded: nothing to collect
    expect(await run()).toMatchObject({ ok: true, actions: 0 });
    // a buy pays the trading fee into the pool: the first collection takes the partner's share
    await h.curveBuy(seriesId, a, USDC(400));
    const t1 = await h.sim.now();
    expect(await run()).toMatchObject({ ok: true, actions: 1 });
    expect(await curve()).toMatchObject({ tradingFeeUncollected: '0', collected: { tradingFee: USDC(3.2).toString(), migrationFee: '0' } });
    // within the week the fees wait in the pool
    await h.curveBuy(seriesId, b, USDC(350));
    expect(await run()).toMatchObject({ ok: true, actions: 0 });
    expect(BigInt((await curve()).tradingFeeUncollected)).toBeGreaterThan(0n);
    await h.sim.advanceTime(7 * DAY - 1);
    expect(await run()).toMatchObject({ ok: true, actions: 0 });
    await h.sim.advanceTime(1);
    const t2 = await h.sim.now();
    expect(await run()).toMatchObject({ ok: true, actions: 1 });
    expect((await curve()).tradingFeeUncollected).toBe('0');
    // the last buy fills the curve: one pass completes it (settled at the pool's finish time) and collects its proceeds
    await h.curveBuy(seriesId, d, USDC(300));
    const finish = (await curve()).finishCurveTimestamp!;
    await h.sim.advanceTime(120);
    expect(await run()).toMatchObject({ ok: true, actions: 2 });
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ phase: 'Settled', settledAt: finish, mintFinalized: true });
    expect(await curve()).toMatchObject({ settled: true, collected: { migrationFee: USDC(990).toString(), proceeds: USDC(990).toString() } });
    expect((await h.sim.getTreasury(seriesId))!.total).toBe(USDC(990).toString());
    // done: nothing more, now or a week later (no fee accrues on a filled curve)
    expect(await run()).toMatchObject({ ok: true, actions: 0 });
    await h.sim.advanceTime(8 * DAY);
    expect(await run()).toMatchObject({ ok: true, actions: 0 });
    // the recorded checks: the first read, each collection, the read the second buy changed and the completion
    const rows = (await t.pool.query('select actions, chain_time::int as at, pool_complete, settled from curve_monitor where series_id = $1 order by id', [seriesId])).rows;
    expect(rows.map((r) => r.actions)).toEqual([[], ['collectCurveProceeds'], [], ['collectCurveProceeds'], ['completeCurve', 'collectCurveProceeds']]);
    expect(rows.filter((r) => r.actions.length).map((r) => r.at)).toEqual([t1, t2, t2 + 120]);
    expect(rows.at(-1)).toMatchObject({ pool_complete: true, settled: true });
  });

  it('curve.lifecycle skips a step another sender took first and reports an unexpected refusal by code only', async () => {
    const key = 'curve-life-race';
    const h = await solana(key);
    const [a, b, d] = h.backers as [SimWallet, SimWallet, SimWallet];
    const seriesId = await curveFilledBy(h, [[a, 400], [b, 350], [d, 300]]);
    // someone completes and collects between the keeper's read and its send: the stale read still says Open
    const stale = await h.sim.getSeries(seriesId);
    await h.completeAndCollect(seriesId);
    const racing = wrap(h.sim, 'listSeries', async () => [stale!]);
    expect(await runner(ctxOf(key, racing), curveLifecycleJob)()).toMatchObject({ ok: true, actions: 0 });
    // a refusal that is not "done" fails the run with the series and a code; its message (values) is never kept
    const h2 = await solana(`${key}-2`);
    const s2 = await curveFilledBy(h2, h2.backers.slice(0, 3).map((w, i) => [w, [400, 350, 300][i]!] as [SimWallet, number]));
    const broke = wrap(h2.sim, 'submit', async () => {
      throw new ChainError('InsufficientFunds', 'fee payer is short by 123456789 lamports', { short: '123456789' });
    });
    const out = await runner(ctxOf(`${key}-2`, broke), curveLifecycleJob)();
    expect(out).toMatchObject({ ok: false, actions: 0, detail: `errors: ${s2}: InsufficientFunds` });
    expect((await t.pool.query("select detail from keeper_runs where job = 'curve.lifecycle' and detail like '%123456789%'")).rowCount).toBe(0);
  });

  it('curveSyncDue: once after completion, then once per period end plus the margin unless a census postdates it; never before settlement or when terminal', () => {
    const q1 = periodOf(GENESIS);
    const settledAt = GENESIS + 10 * DAY;
    const base = { terms: { raiseStyle: 'curve' }, phase: 'Settled', status: 'OnTime', settledAt, unitsSyncedAt: null } as unknown as SeriesState;
    const at = (over: Partial<SeriesState>, now: number) => curveSyncDue({ ...base, ...over } as SeriesState, now);
    expect(at({}, settledAt + 60)).toEqual({ reason: 'completion' });
    // a census taken while the curve was still selling predates the settlement: one more after it
    expect(at({ unitsSyncedAt: settledAt - 1 }, settledAt + 60)).toEqual({ reason: 'completion' });
    expect(at({ unitsSyncedAt: settledAt + 60 }, q1.end - 1)).toBeNull();
    expect(at({ unitsSyncedAt: settledAt + 60 }, q1.end + CURVE_SYNC_MARGIN_SECONDS - 1)).toBeNull();
    expect(at({ unitsSyncedAt: settledAt + 60 }, q1.end + CURVE_SYNC_MARGIN_SECONDS)).toEqual({ reason: 'period-end', periodId: q1.id, periodEnd: q1.end });
    expect(at({ unitsSyncedAt: q1.end }, q1.end + 30 * DAY)).toBeNull();
    // the latest period end counts: a keeper that was down a whole quarter takes one census for it
    const q2 = periodOfPid(q1.pid + 1);
    expect(at({ unitsSyncedAt: settledAt + 60 }, q2.end + 2 * DAY)).toEqual({ reason: 'period-end', periodId: q2.id, periodEnd: q2.end });
    // a curve settled after the last period end has no period census due yet
    expect(at({ settledAt: q1.end + DAY, unitsSyncedAt: q1.end + DAY }, q1.end + 2 * DAY)).toBeNull();
    for (const status of ['Retired', 'Redeemed', 'Extinguished']) expect(at({ status } as Partial<SeriesState>, q1.end + DAY)).toBeNull();
    expect(at({ phase: 'Open', settledAt: null }, settledAt)).toBeNull();
    expect(at({ terms: { raiseStyle: 'sealed-bid' } } as unknown as Partial<SeriesState>, settledAt)).toBeNull();
  });

  it('curve.sync takes the census after completion and after each period end, holds while an assembled report binds it (H1), and never on a terminal series', async () => {
    const key = 'curve-sync';
    const h = await solana(key);
    const c = ctxOf(key, h.sim);
    const [a, b, d] = h.backers as [SimWallet, SimWallet, SimWallet];
    const seriesId = await curveFilledBy(h, [[a, 400], [b, 350], [d, 300]]);
    const sync = runner(c, curveSyncJob);
    const series = async () => (await h.sim.getSeries(seriesId))!;
    // still Open (the curve filled, nobody completed it): no census
    expect(await sync()).toMatchObject({ ok: true, actions: 0 });
    expect(await runner(c, curveLifecycleJob)()).toMatchObject({ ok: true, actions: 2 });
    // once after completion, so holders can stake
    expect(await sync()).toMatchObject({ ok: true, actions: 1 });
    expect(await series()).toMatchObject({ unitsSyncedAt: await h.sim.now(), unitsOutstanding: '100000000' });
    expect(await sync()).toMatchObject({ ok: true, actions: 0 });
    // the settlement quarter's end: not before the margin, then once
    const q1 = periodOf((await series()).settledAt!);
    await h.sim.setTime(q1.end + CURVE_SYNC_MARGIN_SECONDS - 1);
    expect(await sync()).toMatchObject({ ok: true, actions: 0 });
    await h.sim.setTime(q1.end + CURVE_SYNC_MARGIN_SECONDS);
    expect(await sync()).toMatchObject({ ok: true, actions: 1 });
    expect((await series()).unitsSyncedAt).toBe(q1.end + CURVE_SYNC_MARGIN_SECONDS);
    expect(await sync()).toMatchObject({ ok: true, actions: 0 });
    // the issuer assembled its Q1 report over that census and has not sent it: the next quarter's census waits (H1)
    expect((await series()).reporting.nextExpectedPeriod).toBe(q1.id);
    await t.pool.query(
      "insert into reports (report_id, series_id, period_id, account_id, tier, source, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof) values ('rep-h1', $1, $2, 'acc-iss', 2, 'test', 0, '0x0', '0x0', 'none', 0, '{}')",
      [seriesId, q1.id],
    );
    const q2 = periodOfPid(q1.pid + 1);
    await h.sim.setTime(q2.end + CURVE_SYNC_MARGIN_SECONDS);
    expect(await sync()).toMatchObject({ ok: true, actions: 0, detail: '1 held for an assembled report' });
    expect((await series()).unitsSyncedAt).toBe(q1.end + CURVE_SYNC_MARGIN_SECONDS);
    // once it is submitted the census goes ahead
    await t.pool.query("update reports set state = 'submitted' where report_id = 'rep-h1'");
    expect(await sync()).toMatchObject({ ok: true, actions: 1 });
    // a terminal series takes no census (white-box: Retired), and a stale read that misses it is a routine refusal
    const live = await series();
    h.sim.state.series.get(seriesId)!.status = 'Retired';
    const q3 = periodOfPid(q2.pid + 1);
    await h.sim.setTime(q3.end + CURVE_SYNC_MARGIN_SECONDS);
    expect(await sync()).toMatchObject({ ok: true, actions: 0 });
    const stale = wrap(h.sim, 'listSeries', async () => [{ ...live, status: 'OnTime' }]);
    expect(await runner(ctxOf(key, stale), curveSyncJob)()).toMatchObject({ ok: true, actions: 0 });
    await expect(h.sim.submit({ kind: 'syncCurveUnits', seriesId }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'TerminalStatus' } });
    // any other refusal fails the run with the series and a code, never the message
    h.sim.state.series.get(seriesId)!.status = 'OnTime';
    const broke = wrap(h.sim, 'submit', async () => {
      throw new ChainError('ChainSpecific', 'compute budget exceeded at 1400000 units');
    });
    const out = await runner(ctxOf(key, broke), curveSyncJob)();
    expect(out).toMatchObject({ ok: false, actions: 0, detail: `errors: ${seriesId}: ChainSpecific` });
    expect(out.detail).not.toContain('1400000');
  });

  /** Link `wallets` to accounts of their own (`acc-<name>`) on chain `key`. */
  async function link(c: ServiceContext, key: string, wallets: Record<string, string>): Promise<void> {
    for (const [name, address] of Object.entries(wallets)) await new IdentityService(c).seedAccount({ accountId: `acc-${key}-${name}`, wallets: [{ chain: key, address, family: 'solana' }], roles: ['backer'], eligible: false });
  }
  const reminders = async (key: string, kind: string) =>
    (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'chain' = $1 and payload->>'kind' = $2 order by id", [key, kind])).rows.map((r) => r.payload as Record<string, unknown>);
  /** A rendered reminder holds no amount: once the series id and the wallet are taken out, no digit is left. */
  const amountFree = (p: Record<string, unknown>) => {
    const { subject, body } = TEMPLATES[String(p.kind)]!(safeData(p));
    return `${subject} ${body}`.replaceAll(String(p.seriesId), '').replaceAll(String(p.wallet), '');
  };

  it('curve.stake-reminders: each linked wallet holding unstaked units of a settled curve with a census, once per payment round and next step, with no amount', async () => {
    const key = 'curve-remind';
    const h = await solana(key);
    const c = ctxOf(key, h.sim);
    const [a, b, , idle] = h.backers as [SimWallet, SimWallet, SimWallet, SimWallet];
    // a wallet that was never approved buys too: anyone can buy on the curve
    const never = new SimWallet('solana', 'remind-never-approved');
    await h.sim.fund(never.address, 'USDC', USDC(1_000));
    await link(c, key, { a: a.address, b: b.address, never: never.address, idle: idle.address, issuer: h.issuer.address });
    const { seriesId, terms, privateTerms } = await h.createCurve();
    await h.curveBuy(seriesId, a, USDC(400));
    await h.curveBuy(seriesId, b, USDC(350));
    const remind = runner(c, curveStakeRemindersJob);
    // Open: no reminder
    expect(await remind()).toMatchObject({ ok: true, actions: 0 });
    await h.curveBuy(seriesId, never, USDC(400));
    expect(await runner(c, curveLifecycleJob)()).toMatchObject({ ok: true, actions: 2 });
    // settled, no census yet: staking would fail (StakeExceedsOutstanding), so no reminder
    expect(await remind()).toMatchObject({ ok: true, actions: 0 });
    expect(await runner(c, curveSyncJob)()).toMatchObject({ ok: true, actions: 1 });
    // b registers and stakes part of its units
    await h.registerHolder(seriesId, b);
    await h.stake(seriesId, b, 10_000_000n);
    expect(await remind()).toMatchObject({ ok: true, actions: 3 });
    const sent = await reminders(key, 'curve.stake-reminder');
    // the next step per wallet: approved and not registered, registered with units left in its wallet, never approved;
    // the linked wallet holding nothing and the issuer get nothing
    expect(sent.map((p) => [p.wallet, p.next]).sort()).toEqual([[a.address, 'register-and-stake'], [b.address, 'stake'], [never.address, 'approve-wallet']].sort());
    for (const p of sent) {
      expect(p).toEqual({ kind: 'curve.stake-reminder', seriesId, chain: key, wallet: p.wallet, raiseStyle: 'curve', next: p.next });
      expect(amountFree(p)).not.toMatch(/\d/);
    }
    const body = (w: SimWallet) => TEMPLATES['curve.stake-reminder']!(safeData(sent.find((p) => p.wallet === w.address)!)).body;
    expect(body(a)).toBe(`Your wallet ${a.address} holds units of series ${seriesId} that are not staked, so they earn nothing. Register the wallet as a holder of the series, then stake its units: staked units earn from the next payment, and you can unstake at any time.`);
    expect(body(b)).toMatch(/not staked, so they earn nothing\. Stake its units: staked units earn from the next payment/);
    expect(body(never)).toMatch(/needs an approved \(allowlisted\) wallet, and this one is not: until it is approved its units cannot be staked and earn nothing, and it can only sell them\.$/);
    for (const p of sent) expect(amountFree(p)).not.toMatch(/default/i);
    // once per round and step: nothing new, until a step changes (a registers)
    expect(await remind()).toMatchObject({ ok: true, actions: 0 });
    await h.registerHolder(seriesId, a);
    expect(await remind()).toMatchObject({ ok: true, actions: 1 });
    expect((await reminders(key, 'curve.stake-reminder')).at(-1)).toMatchObject({ wallet: a.address, next: 'stake' });
    // b stakes the rest of its wallet: nothing unstaked is left there
    await h.stake(seriesId, b, h.sim.curveUnitsOf(seriesId, b.address));
    // a payment round (the keepers' census after Q1, the report and the payment): those still unstaked hear again
    const q1 = periodOf((await h.sim.getSeries(seriesId))!.settledAt!);
    await h.sim.setTime(q1.end + CURVE_SYNC_MARGIN_SECONDS);
    expect(await runner(c, curveSyncJob)()).toMatchObject({ ok: true, actions: 1 });
    await h.reportAndPay(seriesId, q1.id, privateTerms, terms.termsCommitment, 0n, USDC(65_000));
    expect((await h.sim.getSeries(seriesId))!.status).not.toBe('Retired');
    expect((await h.sim.getSeries(seriesId))!.reporting.lastPaidPeriod).toBe(q1.id);
    expect(await remind()).toMatchObject({ ok: true, actions: 2 });
    expect((await reminders(key, 'curve.stake-reminder')).slice(-2).map((p) => [p.wallet, p.next]).sort()).toEqual([[a.address, 'stake'], [never.address, 'approve-wallet']].sort());
    expect((await t.pool.query("select target from reminders_sent where kind = 'curve.stake-reminder' and recipient = $1", [a.address])).rows.map((r) => r.target).sort()).toEqual(
      [`${seriesId}:${q1.id}:stake`, `${seriesId}:settled:register-and-stake`, `${seriesId}:settled:stake`],
    );
    // a terminal series reminds nobody to stake (white-box: Retired)
    h.sim.state.series.get(seriesId)!.status = 'Retired';
    await t.pool.query("delete from reminders_sent where kind = 'curve.stake-reminder' and target like $1", [`${seriesId}:%`]);
    expect(await remind()).toMatchObject({ ok: true, actions: 0 });
  });

  it('curve.tender-reminders: once a curve redeemed and while its quota lasts, each linked wallet holding units in its wallet, by next step', async () => {
    const key = 'curve-tender';
    const h = await solana(key);
    const c = ctxOf(key, h.sim);
    const [a, b, d] = h.backers as [SimWallet, SimWallet, SimWallet];
    const never = new SimWallet('solana', 'tender-never-approved');
    await h.sim.fund(never.address, 'USDC', USDC(1_000));
    await link(c, key, { a: a.address, b: b.address, d: d.address, never: never.address });
    const seriesId = await curveFilledBy(h, [[a, 300], [b, 200], [d, 200], [never, 400]]);
    expect(await runner(c, curveLifecycleJob)()).toMatchObject({ ok: true, actions: 2 });
    expect(await runner(c, curveSyncJob)()).toMatchObject({ ok: true, actions: 1 });
    // b stakes everything it holds; d registers and keeps its units in its wallet
    await h.registerHolder(seriesId, b);
    await h.stake(seriesId, b, h.sim.curveUnitsOf(seriesId, b.address));
    await h.registerHolder(seriesId, d);
    const tender = runner(c, curveTenderRemindersJob);
    // not redeemed: no tender reminder
    expect(await tender()).toMatchObject({ ok: true, actions: 0 });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Redeemed');
    // Redeemed is terminal for staking: no stake reminder
    expect(await runner(c, curveStakeRemindersJob)()).toMatchObject({ ok: true, actions: 0 });
    // the quota is gone (white-box): wallet units cannot be tendered, so nobody is told to
    const x = h.sim.state.series.get(seriesId)!;
    x.tenderedTotal = x.redemption!.unitsAtRedemption - x.stakedTotal;
    expect(await tender()).toMatchObject({ ok: true, actions: 0 });
    x.tenderedTotal = 0n;
    expect(await tender()).toMatchObject({ ok: true, actions: 3 });
    const sent = await reminders(key, 'curve.tender-reminder');
    // b staked all (its stake is reserved; the chain notice tells it); a may register and tender, d tenders, never cannot
    expect(sent.map((p) => [p.wallet, p.next]).sort()).toEqual([[a.address, 'register-and-tender'], [d.address, 'tender'], [never.address, 'approve-wallet']].sort());
    for (const p of sent) {
      expect(p).toEqual({ kind: 'curve.tender-reminder', seriesId, chain: key, wallet: p.wallet, raiseStyle: 'curve', next: p.next });
      expect(amountFree(p)).not.toMatch(/\d|default/i);
    }
    const body = (w: SimWallet) => TEMPLATES['curve.tender-reminder']!(safeData(sent.find((p) => p.wallet === w.address)!)).body;
    expect(body(d)).toBe(`Your wallet ${d.address} holds units of series ${seriesId}, which has redeemed. Units in wallets share a quota that can run out; staked units are reserved for their holders. Tender its units with tenderUnits.`);
    expect(body(a)).toMatch(/Register the wallet as a holder of the series, then tender its units with tenderUnits\.$/);
    expect(body(never)).toMatch(/Only a registered holder can tender, and registering needs an approved \(allowlisted\) wallet, which this one is not: until it is approved it can only sell its units\.$/);
    expect(await tender()).toMatchObject({ ok: true, actions: 0 });
    // d tenders its wallet units: a later reminder would not reach it, and the others were told once
    await h.tender(seriesId, d, 0n, h.sim.curveUnitsOf(seriesId, d.address));
    expect(await tender()).toMatchObject({ ok: true, actions: 0 });
  });
});

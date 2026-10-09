import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { parsePeriod } from '@merces/math';
import { PgSimPersistence, SimHarness, SimulatorChain } from '@merces/simulator';
import type { ChainPort, DomainEvent } from '@merces/domain';
import { Indexer } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;

describe.skipIf(!dbTestsEnabled())('indexer (E1)', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  beforeAll(async () => {
    t = await createTestSchema();
  });
  afterAll(async () => {
    await t.drop();
  });

  it('projects a full cycle from both chains into one read model, resumably and idempotently', async () => {
    const sol = await SimHarness.create('solana', { genesis: GENESIS });
    const mon = await SimHarness.create('monad', { genesis: GENESIS });
    const idx = new Indexer(t.pool, [sol.sim, mon.sim], { batchSize: 7, logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    const a = await sol.runRaise();
    const b = await mon.runRaise({ terms: { unitsOffered: '600' } });
    await sol.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    await sol.reportAndPay(a.seriesId, '2026Q1', a.privateTerms, a.terms.termsCommitment, 0n, USDC(10_000));
    await sol.reportAndPay(a.seriesId, '2026Q2', a.privateTerms, a.terms.termsCommitment, USDC(10_000), USDC(50_000));
    await sol.reportAndPay(a.seriesId, '2026Q3', a.privateTerms, a.terms.termsCommitment, USDC(50_000), USDC(75_000));
    await sol.exec(sol.backers[0]!, { kind: 'claimPayout', seriesId: a.seriesId });

    const n1 = await idx.catchUp();
    expect(n1).toBeGreaterThan(20);
    const n2 = await idx.catchUp();
    expect(n2).toBe(0);

    const series = await t.pool.query('select series_id, chain, phase, status, units_outstanding::text, issue_price::text, cap_per_unit::text, gross_paid_total::text from series order by chain');
    expect(series.rows).toHaveLength(2);
    const solRow = series.rows.find((r) => r.chain === 'solana')!;
    expect(solRow.phase).toBe('Settled');
    expect(solRow.units_outstanding).toBe('500');
    expect(solRow.cap_per_unit).toBe(USDC(22.5).toString());
    expect(solRow.gross_paid_total).toBe(USDC(1500).toString());
    const monRow = series.rows.find((r) => r.chain === 'monad')!;
    expect(monRow.series_id).toBe(b.seriesId);

    const periods = await t.pool.query('select period_id, settled, payment_due::text, paid::text from periods where series_id = $1 order by period_id', [a.seriesId]);
    expect(periods.rows.map((r) => [r.period_id, r.settled, r.paid])).toEqual([['2026Q1', true, '0'], ['2026Q2', true, '0'], ['2026Q3', true, USDC(1500).toString()]]);
    const pos = await t.pool.query('select units::text, claimed_total::text from positions where series_id = $1 and wallet = $2', [a.seriesId, sol.backers[0]!.address]);
    expect(pos.rows[0]).toEqual({ units: '100', claimed_total: USDC(285).toString() });
    const fees = await t.pool.query('select kind, sum(amount)::text as total from fees_ledger where series_id = $1 group by kind order by kind', [a.seriesId]);
    expect(fees.rows).toEqual([{ kind: 'auction', total: USDC(45).toString() }, { kind: 'payout', total: USDC(75).toString() }]);

    // the public activity feed carries no amounts
    const act = await t.pool.query('select summary from activity');
    const text = act.rows.map((r) => r.summary).join('\n');
    expect(text).not.toMatch(/1500000000|285000000|4500000000/);
    expect(text).toContain('Payment received for 2026Q3');

    // resumable: a fresh indexer instance continues from the stored cursor
    const cur = await idx.cursor('solana');
    expect(cur.lastSeq).toBeGreaterThan(0);
    await sol.exec(sol.backers[1]!, { kind: 'claimPayout', seriesId: a.seriesId });
    const idx2 = new Indexer(t.pool, [sol.sim, mon.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    expect(await idx2.catchUp()).toBe(1);
  });

  it('survives duplicate, out-of-order and confirmed-only delivery (reorg safety)', async () => {
    const key = 'monad-reorg-test';
    const h = await SimHarness.create('monad', { genesis: GENESIS, sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const all = (await h.sim.readEvents(null, 1000)).events; // includes bootstrap events
    // deliver shuffled with duplicates
    const shuffled = [...all, ...all.slice(0, 3)].sort(() => Math.random() - 0.5);
    const applied = await idx.apply(key, shuffled, shuffled.at(-1)!.cursor);
    expect(applied).toBe(all.length);
    expect(await idx.apply(key, all, all.at(-1)!.cursor)).toBe(0);
    // a confirmed-only event is parked, not projected; its finalized twin is projected once
    const next: DomainEvent = { ...all.at(-1)!, seq: all.length + 1, cursor: String(all.length + 1).padStart(12, '0'), finality: 'confirmed', type: 'AllowlistUpdated', payload: { wallet: 'w-reorg', allowed: true } };
    expect(await idx.apply(key, [next], next.cursor)).toBe(0);
    expect((await t.pool.query('select count(*)::int as n from events_pending where chain = $1', [key])).rows[0]!.n).toBe(1);
    expect((await t.pool.query("select count(*)::int as n from allowlist where wallet = 'w-reorg'")).rows[0]!.n).toBe(0);
    // reorg: the finalized version differs (allowed=false); only it reaches the read model
    const fin: DomainEvent = { ...next, finality: 'finalized', payload: { wallet: 'w-reorg', allowed: false } };
    expect(await idx.apply(key, [fin], fin.cursor)).toBe(1);
    expect((await t.pool.query("select allowed from allowlist where wallet = 'w-reorg'")).rows[0]!.allowed).toBe(false);
    expect((await t.pool.query('select count(*)::int as n from events_pending where chain = $1', [key])).rows[0]!.n).toBe(0);
    // a gap stops the batch and leaves the cursor untouched
    const gap: DomainEvent = { ...fin, seq: fin.seq + 5, cursor: String(fin.seq + 5).padStart(12, '0') };
    expect(await idx.apply(key, [gap], gap.cursor)).toBe(0);
    expect((await idx.cursor(key)).lastSeq).toBe(fin.seq);
  });

  it('enqueues chain notices in the projection transaction, one per event, so repeated transitions each notify', async () => {
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'notices', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    const a = await h.runRaise();
    await idx.catchUp();
    const settled = await t.pool.query("select payload from outbox where payload->>'chain' = 'notices' and payload->>'kind' = 'auction.settled'");
    expect(settled.rows).toHaveLength(1);
    expect(settled.rows[0].payload).toMatchObject({ seriesId: a.seriesId, chain: 'notices' });
    expect(typeof settled.rows[0].payload.seq).toBe('number');
    // the same transition twice (OnTime → InGrace in Q1, recover, OnTime → InGrace again in Q2) gives two distinct notices
    const q1 = parsePeriod('2026Q1');
    const q2 = parsePeriod('2026Q2');
    await h.sim.setTime(q1.end + 31 * 86_400);
    await h.sim.submit({ kind: 'crankStatus', seriesId: a.seriesId }, 'keeper');
    await h.reportAndPay(a.seriesId, '2026Q1', a.privateTerms, a.terms.termsCommitment, 0n, USDC(10_000));
    await h.sim.setTime(q2.end + 31 * 86_400);
    await h.sim.submit({ kind: 'crankStatus', seriesId: a.seriesId }, 'keeper');
    await idx.catchUp();
    const toGrace = await t.pool.query("select payload from outbox where payload->>'chain' = 'notices' and payload->>'kind' = 'series.StatusChanged' and payload->'payload'->>'to' = 'InGrace'");
    expect(toGrace.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(toGrace.rows.map((r) => r.payload.seq)).size).toBe(toGrace.rows.length);
    // re-indexing the same events adds nothing (the outbox row commits with the projection, exactly once)
    const before = (await t.pool.query("select count(*)::int as n from outbox where payload->>'chain' = 'notices'")).rows[0].n;
    expect(await idx.catchUp()).toBe(0);
    expect((await t.pool.query("select count(*)::int as n from outbox where payload->>'chain' = 'notices'")).rows[0].n).toBe(before);
  });

  it('projects the due and accrual recomputed at payment time, not the report-time figures', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'late-pay', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    const a = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    // report 10 days after grace, pay 40 days after grace: interest keeps running in between
    await h.sim.setTime(q1.end + 55 * 86_400);
    const { command } = await h.buildReport({ seriesId: a.seriesId, periodId: '2026Q1', unitsOutstanding: 500n, privateTerms: a.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(100_000), termsCommitment: a.terms.termsCommitment });
    const accepted = (await h.exec(h.issuer, command)).events.find((e) => e.type === 'ReportAccepted')!.payload as { paymentDue: string; accrual: string };
    await idx.catchUp();
    await h.sim.setTime(q1.end + 85 * 86_400);
    const live = (await h.sim.getPeriod(a.seriesId, '2026Q1'))!;
    expect(BigInt(live.paymentDue)).toBeGreaterThan(BigInt(accepted.paymentDue));
    const paid = await h.exec(h.issuer, { kind: 'payIn', seriesId: a.seriesId, periodId: '2026Q1', amount: live.paymentDue });
    expect(paid.events.find((e) => e.type === 'PaymentReceived')!.payload).toMatchObject({ source: 'payIn', paymentDue: live.paymentDue, accrual: live.accrual });
    await idx.catchUp();
    const chain = (await h.sim.getPeriod(a.seriesId, '2026Q1'))!;
    const row = (await t.pool.query('select payment_due::text, accrual::text, paid::text, settled from periods where series_id = $1 and period_id = $2', [a.seriesId, '2026Q1'])).rows[0];
    expect(row).toEqual({ payment_due: chain.paymentDue, accrual: chain.accrual, paid: chain.paid, settled: true });
    expect(row.payment_due).toBe(live.paymentDue);
  });

  it('keeps indexing the other chains when one chain fails, and still reports the failure', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'isolated', genesis: GENESIS, acceptMockProofs: true }) });
    await h.runRaise();
    const broken = { chain: 'broken', readEvents: async () => { throw new Error('rpc 503'); } } as unknown as ChainPort;
    const idx = new Indexer(t.pool, [broken, h.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    await expect(idx.catchUp()).rejects.toThrow(/broken: rpc 503/);
    const n = (await t.pool.query("select count(*)::int as n from events where chain = 'isolated'")).rows[0].n;
    expect(n).toBeGreaterThan(5);
  });

  it('a persisted simulator chain has one owning process: a second opener is refused until the first closes', async () => {
    const first = await SimulatorChain.create({ personality: 'solana', chainKey: 'owned', genesis: GENESIS, persistence: new PgSimPersistence(t.pool, 'test-single-writer') });
    await expect(SimulatorChain.create({ personality: 'solana', chainKey: 'owned', genesis: GENESIS, persistence: new PgSimPersistence(t.pool, 'test-single-writer') })).rejects.toThrow(/already open in another process/);
    await first.close();
    const second = await SimulatorChain.create({ personality: 'solana', chainKey: 'owned', genesis: GENESIS, persistence: new PgSimPersistence(t.pool, 'test-single-writer') });
    expect((await second.info()).chain).toBe('owned');
    await second.close();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { parsePeriod } from '@merces/math';
import { SimHarness, SimulatorChain } from '@merces/simulator';
import type { DomainEvent } from '@merces/domain';
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
    const h = await SimHarness.create('monad', { genesis: GENESIS, sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS }) });
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
});

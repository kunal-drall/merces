import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { WAD, capPerUnit, parsePeriod } from '@merces/math';
import { PgSimPersistence, SimHarness, SimulatorChain, defaultTerms } from '@merces/simulator';
import { ZERO_INCOME_COMMITMENT, type ChainPort, type DomainEvent } from '@merces/domain';
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
  const quiet = { warn() {}, debug() {}, error() {}, info() {} } as never;
  /** Stage 1's reporting ledger as the indexer projected it into `series` (M8). */
  const ledgerRow = async (seriesId: string) => (await t.pool.query('select first_period, next_expected_period, last_accepted_period, last_paid_period, open_due_period, open_due_amount::text, last_income_period, last_income_commitment, formal_notice_emitted_for from series where series_id = $1', [seriesId])).rows[0];
  /** The same ledger read from the chain. */
  const chainLedger = async (h: SimHarness, seriesId: string) => {
    const s = (await h.sim.getSeries(seriesId))!;
    const r = s.reporting;
    return { first_period: r.firstPeriod, next_expected_period: r.nextExpectedPeriod, last_accepted_period: r.lastAcceptedPeriod, last_paid_period: r.lastPaidPeriod, open_due_period: r.openDuePeriod, open_due_amount: r.openDueAmount, last_income_period: r.lastIncomePeriod, last_income_commitment: r.lastAcceptedPeriod === null ? null : r.lastIncomeCommitment, formal_notice_emitted_for: s.formalNoticeEmittedFor };
  };

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
    // Stage 1's report opens the due without accrual: 10% × (100,000 − 60,000) = 4,000 and accrual 0 (cause R: Stage 1
    // `Report.due`, SIM:1133; was the due plus the accrual up to the report, which this test did not pin)
    expect(accepted).toMatchObject({ paymentDue: USDC(4000).toString(), accrual: '0' });
    await idx.catchUp();
    expect((await t.pool.query('select payment_due::text, accrual::text from periods where series_id = $1 and period_id = $2', [a.seriesId, '2026Q1'])).rows[0]).toEqual({ payment_due: USDC(4000).toString(), accrual: '0' });
    await h.sim.setTime(q1.end + 85 * 86_400);
    const live = (await h.sim.getPeriod(a.seriesId, '2026Q1'))!;
    expect(BigInt(live.paymentDue)).toBeGreaterThan(BigInt(accepted.paymentDue));
    // Stage 1 lateAccrual at the payment: 40 whole days past grace → floor(4,000 × 8% × 40 / 365) = 35.068493 USDC
    // (cause R; Stage 1's own pay on the same flow takes 4,035,068,493)
    expect([live.accrual, live.paymentDue]).toEqual(['35068493', '4035068493']);
    const paid = await h.exec(h.issuer, { kind: 'payIn', seriesId: a.seriesId, periodId: '2026Q1', amount: live.paymentDue });
    expect(paid.events.find((e) => e.type === 'PaymentReceived')!.payload).toMatchObject({ source: 'payIn', paymentDue: live.paymentDue, accrual: live.accrual });
    await idx.catchUp();
    const chain = (await h.sim.getPeriod(a.seriesId, '2026Q1'))!;
    const row = (await t.pool.query('select payment_due::text, accrual::text, paid::text, settled from periods where series_id = $1 and period_id = $2', [a.seriesId, '2026Q1'])).rows[0];
    expect(row).toEqual({ payment_due: chain.paymentDue, accrual: chain.accrual, paid: chain.paid, settled: true });
    expect(row.payment_due).toBe(live.paymentDue);
  });

  it('projects Stage 1\'s reporting ledger and the report prior (M8): the series row follows the chain', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'ledger', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const a = await h.runRaise();
    const row = () => ledgerRow(a.seriesId);
    const chain = () => chainLedger(h, a.seriesId);
    await idx.catchUp();
    expect(await row()).toEqual(await chain());
    expect((await row()).next_expected_period).toBe('2026Q1');
    // Q1 below the threshold: due 0, paid at once
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const q1 = await h.buildReport({ seriesId: a.seriesId, periodId: '2026Q1', privateTerms: a.privateTerms, incomeYtdNow: USDC(10_000) });
    await h.exec(h.issuer, q1.command);
    // Q2 above it: the due stays open until paid
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const q2 = await h.buildReport({ seriesId: a.seriesId, periodId: '2026Q2', privateTerms: a.privateTerms, incomeYtdNow: USDC(100_000) });
    await h.exec(h.issuer, q2.command);
    await idx.catchUp();
    expect(await row()).toEqual(await chain());
    expect(await row()).toMatchObject({ last_accepted_period: '2026Q2', next_expected_period: '2026Q3', last_paid_period: '2026Q1', open_due_period: '2026Q2', open_due_amount: q2.paymentStable.toString(), last_income_commitment: q2.command.incomeCommitment });
    const priors = (await t.pool.query('select period_id, prior_income_commitment from periods where series_id = $1 order by period_id', [a.seriesId])).rows;
    expect(priors).toEqual([{ period_id: '2026Q1', prior_income_commitment: ZERO_INCOME_COMMITMENT }, { period_id: '2026Q2', prior_income_commitment: q1.command.incomeCommitment }]);
    await h.exec(h.issuer, { kind: 'payIn', seriesId: a.seriesId, periodId: '2026Q2', amount: (await h.sim.getPeriod(a.seriesId, '2026Q2'))!.paymentDue });
    // Q3 is never reported: the formal notice is recorded at period end + 90 days
    await h.sim.setTime(parsePeriod('2026Q3').end + 91 * 86_400);
    await h.sim.submit({ kind: 'crankStatus', seriesId: a.seriesId }, 'keeper');
    await idx.catchUp();
    expect(await row()).toEqual(await chain());
    expect(await row()).toMatchObject({ last_paid_period: '2026Q2', open_due_period: null, open_due_amount: '0', formal_notice_emitted_for: '2026Q3' });
  });

  // S1 review: Stage 1's `retire` clears the open due on every path (SIM:445-454). A payment for the open period
  // clears it on its own; a split receipt that reaches the cap does not, and no payIn can follow on a Retired series,
  // so the row must follow SeriesRetired or it keeps an open due forever.
  it('a retirement clears the open due, through a split receipt and through a payIn: the series row follows the chain', async () => {
    for (const personality of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(personality, { sim: SimulatorChain.createSync({ personality, chainKey: `retire-${personality}`, genesis: GENESIS, acceptMockProofs: true }) });
      const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
      const status = async (seriesId: string) => (await t.pool.query('select status from series where series_id = $1', [seriesId])).rows[0].status;
      // the cap is 2.5 × 9 = 22.5 USDC per unit, 11,250 USDC over 500 units
      const split = await h.runRaise({ terms: { tierFlags: { tier1: true, tier2: false, tier3: false, tier4: false } } });
      const paid = await h.runRaise();
      await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId: split.seriesId, router: h.router });
      await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
      // a pure tier-1 series reports Q1 and leaves the due open
      const q1 = await h.buildReport({ seriesId: split.seriesId, periodId: '2026Q1', privateTerms: split.privateTerms, incomeYtdNow: USDC(100_000), tier: 1 });
      await h.exec(h.issuer, q1.command);
      await idx.catchUp();
      expect(await ledgerRow(split.seriesId)).toEqual(await chainLedger(h, split.seriesId));
      expect(await ledgerRow(split.seriesId)).toMatchObject({ open_due_period: '2026Q1', open_due_amount: q1.paymentStable.toString() });
      // the router's income reaches the cap: the series retires with the Q1 due unpaid, and Stage 1 owes nothing more
      const receipt = await h.sim.postSplitReceipt(h.router, split.seriesId, USDC(20_000));
      expect(receipt.events.map((e) => e.type)).toEqual(['PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired', 'SplitReceipt']);
      await idx.catchUp();
      expect((await h.sim.getSeries(split.seriesId))!.reporting).toMatchObject({ openDuePeriod: null, openDueAmount: '0' });
      expect(await status(split.seriesId)).toBe('Retired');
      expect(await ledgerRow(split.seriesId)).toEqual(await chainLedger(h, split.seriesId));
      expect(await ledgerRow(split.seriesId)).toMatchObject({ last_paid_period: null, open_due_period: null, open_due_amount: '0' });
      // the period keeps the due it reported and stays unsettled, on the chain and in the row
      const period = (await h.sim.getPeriod(split.seriesId, '2026Q1'))!;
      expect(period).toMatchObject({ paymentDue: q1.paymentStable.toString(), settled: false });
      expect((await t.pool.query('select payment_due::text, settled from periods where series_id = $1 and period_id = $2', [split.seriesId, '2026Q1'])).rows[0]).toEqual({ payment_due: period.paymentDue, settled: period.settled });
      // a payIn that reaches the cap: the payment closes the due, then the series retires (the row still follows)
      const big = await h.buildReport({ seriesId: paid.seriesId, periodId: '2026Q1', privateTerms: paid.privateTerms, incomeYtdNow: USDC(200_000) });
      await h.exec(h.issuer, big.command);
      const due = (await h.sim.getPeriod(paid.seriesId, '2026Q1'))!.paymentDue;
      const pay = await h.exec(h.issuer, { kind: 'payIn', seriesId: paid.seriesId, periodId: '2026Q1', amount: due });
      expect(pay.events.map((e) => e.type)).toContain('SeriesRetired');
      await idx.catchUp();
      expect(await status(paid.seriesId)).toBe('Retired');
      expect(await ledgerRow(paid.seriesId)).toEqual(await chainLedger(h, paid.seriesId));
      expect(await ledgerRow(paid.seriesId)).toMatchObject({ last_paid_period: '2026Q1', open_due_period: null, open_due_amount: '0' });
    }
  });

  it('projects the cap per unit with Stage 1\'s floor at settlement and after an amendment (never SQL rounding)', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'amended', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: { warn() {}, debug() {}, error() {}, info() {} } as never });
    const a = await h.runRaise();
    const cap = async () => (await t.pool.query('select cap_multiple_wad::text, cap_per_unit::text from series where series_id = $1', [a.seriesId])).rows[0];
    await idx.catchUp();
    expect(await cap()).toEqual({ cap_multiple_wad: a.terms.capMultipleWad, cap_per_unit: (await h.sim.getSeries(a.seriesId))!.capPerUnit });
    // m × P0 / 1e18 = 21,600,000.500000004: Stage 1 floors to 21,600,000; a numeric(38,0) division rounds it up to 21,600,001
    const m = 2_400_000_055_555_555_556n;
    expect(a.clearingPrice).toBe(USDC(9));
    await h.exec(h.issuer, { kind: 'amendTerms', seriesId: a.seriesId, termsCommitment: a.terms.termsCommitment, capMultipleWad: m.toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    await idx.catchUp();
    expect((await h.sim.getSeries(a.seriesId))!.capPerUnit).toBe('21600000');
    expect(await cap()).toEqual({ cap_multiple_wad: m.toString(), cap_per_unit: '21600000' });
    const sql = (await t.pool.query('select ($1::numeric * $2::numeric / 1000000000000000000)::numeric(38,0)::text as v', [m.toString(), USDC(9).toString()])).rows[0].v;
    expect(sql).toBe('21600001'); // what the old SQL projection stored
  });

  // S1 review: graduation sets a curve's issue price and its cap per unit onchain, as settlement does for an auction;
  // the row had neither, so the statement's C_remaining, the holdings' yield and every later amendment saw no cap.
  it('projects a graduated curve\'s issue price and cap per unit (Stage 1\'s floor), and the cap after an amendment', async () => {
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'curve-cap', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(1200).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const seriesId = ((await h.exec(h.issuer, { kind: 'createSeries', terms })).events[0]!.payload as { seriesId: string }).seriesId;
    const types: string[] = [];
    for (const b of [0, 1, 2]) types.push(...(await h.exec(h.backers[b]!, { kind: 'buyCurve', seriesId, amountIn: USDC(400).toString(), minUnitsOut: '0' })).events.map((e) => e.type));
    expect(types.at(-1)).toBe('CurveGraduated');
    await idx.catchUp();
    const row = async () => (await t.pool.query('select phase, issue_price::text, cap_multiple_wad::text, cap_per_unit::text from series where series_id = $1', [seriesId])).rows[0];
    const chain = (await h.sim.getSeries(seriesId))!;
    expect(chain.issuePrice).not.toBeNull();
    expect(await row()).toEqual({ phase: 'Settled', issue_price: chain.issuePrice, cap_multiple_wad: terms.capMultipleWad, cap_per_unit: chain.capPerUnit });
    expect(chain.capPerUnit).toBe(capPerUnit(BigInt(terms.capMultipleWad), BigInt(chain.issuePrice!)).toString());
    // an issuer-favourable amendment: the new cap is Stage 1's capPerUnit on the projected issue price, floor. m puts
    // m × P0 / 1e18 just past 2·P0 + ½, where rounding (a SQL numeric cast) would store one more than the chain
    const p0 = BigInt(chain.issuePrice!);
    const m = 2n * WAD + (WAD / 2n + p0 - 1n) / p0;
    await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: terms.termsCommitment, capMultipleWad: m.toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    await idx.catchUp();
    const amended = (await h.sim.getSeries(seriesId))!.capPerUnit;
    expect(amended).toBe((2n * p0).toString());
    expect(await row()).toMatchObject({ cap_multiple_wad: m.toString(), cap_per_unit: amended });
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

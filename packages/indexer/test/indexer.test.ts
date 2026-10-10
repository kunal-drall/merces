import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { WAD, capPerUnit, parsePeriod, requiredEscrow } from '@merces/math';
import { PgSimPersistence, SimHarness, SimWallet, SimulatorChain, defaultTerms } from '@merces/simulator';
import { ZERO_INCOME_COMMITMENT, bidCommitment, runSettlement, type ChainPort, type DomainEvent, type EventPayload, type EventType } from '@merces/domain';
import { Indexer, project } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;
/*
 * S2 cause codes:
 *  - S2-AD: commit and reveal durations are series terms, projected from SeriesCreated (migration 018);
 *  - S2-MS: Stage 1's settlement events, projected (migration 019);
 *  - S2-FP: a failed raise keeps its price and would-be results;
 *  - S2-RH: registerHolder (`HolderRegistered`);
 *  - S2-PU: per-bid money movement: `TreasuryFunded` per processed winner, one treasury money row each.
 *
 * S3 cause codes:
 *  - S3-TL, S3-FN: `TailClaimed` and `FinalClaimed` write `tail_claim` and `final_claim` money rows (above 0 only) and
 *    add to an existing position's `claimed_total`, never creating a position (A-REV-10);
 *  - S3-Z: a burn of 0 units (`burnRetired` on a wallet holding nothing) changes nothing in the read model;
 *  - S3-IX: `PayoutClaimed` adds to an existing position only (it never creates one, so a registration and a claim of 0
 *    grant no holder access, A-REV-10) and writes a `payout` money row above 0 only, with the units it burns noted.
 *  - S3-CV: a curve on Stage 1's lifecycle (migration 020): `CurveActivated` fixes P0 and the cap while the curve sells
 *    (`RaiseOpened{0, 0}` records no phase ends and no feed line), `CurveGraduated` settles at the finish time with no
 *    treasury and no units outstanding, `CurveProceedsCollected` and `TreasuryFunded` fund the treasury, `FeeTaken`
 *    records the curve trading fee; was: buys minting units and funding the treasury, graduation setting both.
 *  - S3-CN: the curve census (`CurveUnitsSynced`) sets units outstanding, the census time and the stakes; each is kept.
 *  - S3-ST: curve staking (`UnitsStaked`, `UnitsUnstaked`): the first stake creates the position (holder access), its
 *    units are the stake, the series' stakes move; a curve tender (`RedemptionClaimed.fromStake`) upserts the position
 *    (a wallet-only tender included) and lowers only the staked part; a curve `UnitsBurned` touches neither the
 *    position's units nor units outstanding and adds to the tendered total (amendment M3).
 *  - S3-KP: a curve series' chain notices (S3 WP11, amendment M8): `curve.completed` in place of the mint notice,
 *    `curve.tender-open` at a redemption, and every notice of a curve series names its raise style.
 *
 * S3 follow-up cause code:
 *  - NRC: the non-reveal charge is modelled (was the S2 hold): `NonRevealCharged` writes the bid's charge and refund
 *    (migration 022), `FeeTaken{nonReveal}` a fee row, `bid.non-reveal-charged` notifies the bidder; series record the
 *    harness's 100 bps.
 */

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
    // cause S2-AD: the raise's own terms (migration 018), as the series recorded them (the harness's 3-day commit and
    // 1-day reveal; cause NRC: the harness's own 100 bps non-reveal charge, was 0 under the S2 hold), and the phase ends
    // openRaise derived from them
    const raiseTerms = await t.pool.query('select commit_duration_seconds::text, reveal_duration_seconds::text, non_reveal_charge_bps, reveal_ends_at - commit_ends_at as reveal_seconds from series order by chain');
    expect(raiseTerms.rows).toEqual([0, 1].map(() => ({ commit_duration_seconds: '259200', reveal_duration_seconds: '86400', non_reveal_charge_bps: 100, reveal_seconds: '86400' })));

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

  // S1 review: a curve's issue price and its cap per unit must be projected (the statement's C_remaining, the holdings'
  // yield and every later amendment read them). cause S3-CV: they are fixed at activation (Stage 1 mark_curve_activated),
  // the raise settles at the pool's finish time, and only the collection funds the treasury (migration 020)
  it("projects a curve's activation, completion and proceeds, its issue price and cap per unit (Stage 1's floor), and the cap after an amendment", async () => {
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'curve-cap', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId, terms } = await h.createCurve();
    const row = async () => (await t.pool.query('select phase, issue_price::text, units_sold::text, unit_scale::text, cap_multiple_wad::text, cap_per_unit::text, commit_ends_at, settled_at, mint_finalized, units_outstanding::text, treasury_total::text from series where series_id = $1', [seriesId])).rows[0];
    const curveRow = async () => (await t.pool.query('select dbc_pool, base_mint, migration_quote_threshold::text, issue_price::text, units_sold::text, completed, settled_at, proceeds::text, migration_fee::text, surplus::text, trading_fee::text from curves where series_id = $1', [seriesId])).rows[0];
    await idx.catchUp();
    const P0 = '10000000'; // merces-common curve.rs:120-131
    const cap = capPerUnit(BigInt(terms.capMultipleWad), BigInt(P0)).toString();
    expect(await row()).toEqual({ phase: 'Open', issue_price: P0, units_sold: '100000000', unit_scale: '1000000', cap_multiple_wad: terms.capMultipleWad, cap_per_unit: cap, commit_ends_at: null, settled_at: null, mint_finalized: false, units_outstanding: '0', treasury_total: '0' });
    const curve = (await h.sim.getCurve(seriesId))!;
    expect(await curveRow()).toEqual({ dbc_pool: curve.dbcPool, base_mint: curve.baseMint, migration_quote_threshold: '1000000000', issue_price: P0, units_sold: '100000000', completed: false, settled_at: null, proceeds: '0', migration_fee: '0', surplus: '0', trading_fee: '0' });
    for (const [i, amount] of [400, 350, 300].entries()) await h.curveBuy(seriesId, h.backers[i]!, USDC(amount));
    const finishTs = (await h.sim.getCurve(seriesId))!.finishCurveTimestamp!;
    await h.sim.advanceTime(86_400);
    await h.completeAndCollect(seriesId);
    await idx.catchUp();
    // settled at the finish time; no units outstanding (the census's, S3 WP9); the treasury is the partner migration fee
    expect(await row()).toMatchObject({ phase: 'Settled', settled_at: String(finishTs), mint_finalized: true, units_outstanding: '0', treasury_total: '990000000', cap_per_unit: cap });
    expect(await curveRow()).toMatchObject({ completed: true, settled_at: String(finishTs), proceeds: '990000000', migration_fee: '990000000', surplus: '0', trading_fee: '8080809' });
    const money = (await t.pool.query("select kind, amount::text from money_events where series_id = $1 and kind in ('treasury', 'fee') order by seq", [seriesId])).rows;
    expect(money).toEqual([{ kind: 'treasury', amount: '990000000' }, { kind: 'fee', amount: '8080809' }]);
    expect((await t.pool.query('select kind, payer, amount::text from fees_ledger where series_id = $1', [seriesId])).rows).toEqual([{ kind: 'curveTrading', payer: curve.dbcPool, amount: '8080809' }]);
    // the public feed: the curve's opening and its fill, never an amount; the activation's RaiseOpened{0, 0} is not a sealed raise's opening
    const feed = (await t.pool.query('select kind, summary from activity where series_id = $1 order by seq', [seriesId])).rows;
    expect(feed.map((r) => r.kind)).toEqual(['SeriesCreated', 'CurveActivated', 'CurveGraduated', 'RaiseMintFinalized']);
    for (const r of feed) expect(r.summary).not.toMatch(/990|8080809|USDC/);
    const chain = (await h.sim.getSeries(seriesId))!;
    expect(chain.capPerUnit).toBe(cap);
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

  // cause S3-CN: every curve census (Stage 1 CurveUnitsSynced, from `syncCurveUnits` and from `redeem`'s own) becomes
  // the series' units outstanding at the census time, and each is kept in curve_census; the feed names units only
  it("projects every curve census: the series' units outstanding and census time, one curve_census row each", async () => {
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'curve-census', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId } = await h.createCurve();
    await h.fillCurve(seriesId);
    const row = async () => (await t.pool.query('select units_outstanding::text, units_synced_at, staked_total::text from series where series_id = $1', [seriesId])).rows[0];
    const census = async () => (await t.pool.query('select seq, supply::text, protocol_held::text, units_outstanding::text, staked_total::text, synced_at from curve_census where series_id = $1 order by seq', [seriesId])).rows;
    await idx.catchUp();
    expect(await row()).toEqual({ units_outstanding: '0', units_synced_at: null, staked_total: '0' });
    await h.sim.advanceTime(3_600);
    const sync = await h.syncCurve(seriesId);
    await idx.catchUp();
    expect(await row()).toEqual({ units_outstanding: '100000000', units_synced_at: String(sync.blockTime), staked_total: '0' });
    expect(await census()).toEqual([{ seq: String(sync.events[0]!.seq), supply: '110363638', protocol_held: '10363638', units_outstanding: '100000000', staked_total: '0', synced_at: String(sync.blockTime) }]);
    // the redemption's own census leaves the DAMM pool out: the units parked there and the pool's migration deposit
    // (363,637, curve_config.json migrationBaseThreshold) count
    await h.sim.curveHook(seriesId, { kind: 'migrate' });
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: h.backers[2]!.address, units: -5_000_000n });
    await h.sim.advanceTime(60);
    const redeem = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    await idx.catchUp();
    expect(redeem.events[0]!.payload).toMatchObject({ unitsOutstanding: '100363637' });
    expect(await row()).toEqual({ units_outstanding: '100363637', units_synced_at: String(redeem.blockTime), staked_total: '0' });
    expect((await census()).map((r) => [r.units_outstanding, r.synced_at])).toEqual([['100000000', String(sync.blockTime)], ['100363637', String(redeem.blockTime)]]);
    const feed = (await t.pool.query("select summary from activity where series_id = $1 and kind = 'CurveUnitsSynced' order by seq", [seriesId])).rows;
    expect(feed).toEqual([{ summary: 'Units counted: 100000000 base units outstanding' }, { summary: 'Units counted: 100363637 base units outstanding' }]);
  });

  // cause S3-ST (amendment M3): stakes and tenders as the chain records them; a registration alone creates no position
  it('projects curve stakes and tenders: the first stake creates the position, a tender upserts it, units outstanding never move', async () => {
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'curve-stake', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId } = await h.createCurve();
    await h.fillCurve(seriesId);
    const [a, b] = h.backers as [SimWallet, SimWallet];
    for (const w of [a, b]) await h.registerHolder(seriesId, w);
    await h.syncCurve(seriesId);
    const position = async (w: SimWallet) => (await t.pool.query('select units::text, staked_units::text, redeemed_units::text, burned_units::text from positions where series_id = $1 and wallet = $2', [seriesId, w.address])).rows[0];
    const series = async () => (await t.pool.query('select units_outstanding::text, staked_total::text, tendered_total::text from series where series_id = $1', [seriesId])).rows[0];
    await idx.catchUp();
    // registered, not staked: no position row (A-REV-10)
    expect(await position(a)).toBeUndefined();
    const aUnits = h.sim.curveUnitsOf(seriesId, a.address);
    await h.stake(seriesId, a, aUnits);
    await h.stake(seriesId, b, 10_000_000n);
    await h.unstake(seriesId, b, 4_000_000n);
    await idx.catchUp();
    expect(await position(a)).toEqual({ units: aUnits.toString(), staked_units: aUnits.toString(), redeemed_units: '0', burned_units: '0' });
    expect(await position(b)).toEqual({ units: '6000000', staked_units: '6000000', redeemed_units: '0', burned_units: '0' });
    expect(await series()).toEqual({ units_outstanding: '100000000', staked_total: (aUnits + 6_000_000n).toString(), tendered_total: '0' });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    // a tenders its stake; b part of its stake and wallet units; a third holder, registered and never staked, its wallet
    await h.tender(seriesId, a, aUnits, 0n);
    const bWallet = h.sim.curveUnitsOf(seriesId, b.address);
    await h.tender(seriesId, b, 2_000_000n, bWallet);
    const c = h.backers[2]!;
    await h.registerHolder(seriesId, c);
    const cUnits = h.sim.curveUnitsOf(seriesId, c.address);
    await h.tender(seriesId, c, 0n, cUnits);
    await idx.catchUp();
    expect(await position(a)).toEqual({ units: '0', staked_units: '0', redeemed_units: aUnits.toString(), burned_units: aUnits.toString() });
    expect(await position(b)).toEqual({ units: '4000000', staked_units: '4000000', redeemed_units: (2_000_000n + bWallet).toString(), burned_units: (2_000_000n + bWallet).toString() });
    expect(await position(c)).toEqual({ units: '0', staked_units: '0', redeemed_units: cUnits.toString(), burned_units: cUnits.toString() });
    const tendered = aUnits + 2_000_000n + bWallet + cUnits;
    expect(await series()).toEqual({ units_outstanding: '100000000', staked_total: '4000000', tendered_total: tendered.toString() });
    // the chain agrees
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ unitsOutstanding: '100000000', stakedTotal: '4000000', tenderedTotal: tendered.toString() });
    const claims = (await t.pool.query("select wallet, amount::text, detail from money_events where series_id = $1 and kind = 'redemption_claim' order by seq", [seriesId])).rows;
    expect(claims.map((r) => [r.wallet, r.detail.fromStake])).toEqual([[a.address, aUnits.toString()], [b.address, '2000000'], [c.address, '0']]);
    // the feed names units only
    const feed = (await t.pool.query("select summary from activity where series_id = $1 and kind in ('UnitsStaked', 'UnitsUnstaked') order by seq", [seriesId])).rows;
    expect(feed).toEqual([{ summary: `${aUnits} base units staked` }, { summary: '10000000 base units staked' }, { summary: '4000000 base units unstaked' }]);
  });

  // cause S2-MS (S2 WP3): the engine emits these from WP4; synthetic events on a real revealed raise drive the projections
  it('projects the settlement events: rounds, allocations, deliveries, the mint gate and holder registration', async () => {
    const key = 'settle-synthetic';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { terms } = defaultTerms(h.sim);
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const seriesId = ((await h.exec(h.issuer, { kind: 'createSeries', terms })).events[0]!.payload as { seriesId: string }).seriesId;
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const { commitEndsAt } = (await h.sim.getAuction(seriesId))!;
    const bids = [12, 11, 10, 10, 9].map((p, i) => ({ w: h.backers[i]!, price: USDC(p), salt: '0x' + String(i + 1).padStart(2, '0').repeat(32) }));
    for (const b of bids) await h.exec(b.w, { kind: 'commitBid', seriesId, commitment: bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: 100n, salt: b.salt }), deposit: requiredEscrow(b.price, 100n, terms.auctionFeeBps).toString() });
    await h.sim.setTime(commitEndsAt!);
    for (const b of bids) await h.exec(b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: '100', salt: b.salt });
    await idx.catchUp();
    const b0 = bids[0]!.w.address;
    const b4 = bids[4]!.w.address;

    let seq = 1_000_000;
    const ev = <T extends EventType>(type: T, payload: EventPayload<T>): DomainEvent => ({ chain: key, cursor: String(++seq).padStart(12, '0'), seq, blockTime: 1_780_000_000, blockRef: String(seq), txId: `synthetic-${seq}`, finality: 'finalized', type, payload }) as DomainEvent;
    const apply = async (...events: DomainEvent[]) => {
      const c = await t.pool.connect();
      try {
        await c.query('begin');
        for (const e of events) await project(c, e);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    };
    const series = async () => (await t.pool.query('select phase, settlement_round, round_rejected, rejection_reason, mint_finalized, units_outstanding::text from series where series_id = $1', [seriesId])).rows[0];
    const rounds = async () => (await t.pool.query('select round, clearing_price::text, rejected, rejection_reason from settlement_rounds where series_id = $1 order by round', [seriesId])).rows;
    const bid = async (w: string) => (await t.pool.query('select processed, allocated_units::text, cost::text, fee::text, pending_units::text, pending_refund::text, delivered, delivered_units::text, refunded::text from bids where series_id = $1 and bidder = $2', [seriesId, w])).rows[0];
    const pos = async (w: string) => (await t.pool.query('select units::text, undelivered_units::text from positions where series_id = $1 and wallet = $2', [seriesId, w])).rows[0];
    const registered = async (w: string) => !!(await t.pool.query('select 1 from holder_registrations where series_id = $1 and wallet = $2', [seriesId, w])).rowCount;

    // a round proposed, rejected, and a second round proposed
    await apply(ev('SettlementProposed', { seriesId, clearingPrice: USDC(10).toString(), round: 1 }));
    expect(await series()).toMatchObject({ phase: 'Settling', settlement_round: 1, round_rejected: false, rejection_reason: null });
    await apply(ev('SettlementRejected', { seriesId, round: 1, clearingPrice: USDC(10).toString(), reason: 'ClaimMismatch' }));
    expect(await series()).toMatchObject({ phase: 'Settling', settlement_round: 1, round_rejected: true, rejection_reason: 'ClaimMismatch' });
    await apply(ev('SettlementProposed', { seriesId, clearingPrice: USDC(9).toString(), round: 2 }));
    expect(await series()).toMatchObject({ settlement_round: 2, round_rejected: false, rejection_reason: null });
    expect(await rounds()).toEqual([
      { round: 1, clearing_price: USDC(10).toString(), rejected: true, rejection_reason: 'ClaimMismatch' },
      { round: 2, clearing_price: USDC(9).toString(), rejected: false, rejection_reason: null },
    ]);
    await apply(ev('AuctionSettled', { seriesId, clearingPrice: USDC(9).toString(), unitsSold: '500', proceeds: USDC(4500).toString(), settledAt: 1_780_000_000 }));
    expect((await t.pool.query('select auction_clearing_price::text, auction_units_sold::text, auction_proceeds::text, auction_failure_reason, auction_finalized_at::int from series where series_id = $1', [seriesId])).rows[0])
      .toEqual({ auction_clearing_price: USDC(9).toString(), auction_units_sold: '500', auction_proceeds: USDC(4500).toString(), auction_failure_reason: null, auction_finalized_at: 1_780_000_000 });

    // a winner: registered (Stage 1 registers it before allocating, SIM:1005-1006; a registration alone is no
    // position, A-REV-10), processed (its units count from here, undelivered), then delivered
    await apply(ev('HolderRegistered', { seriesId, holder: b0 }));
    expect(await registered(b0)).toBe(true);
    expect(await pos(b0)).toBeUndefined();
    await apply(ev('UnitsAllocated', { seriesId, bidder: b0, units: '100', cost: USDC(900).toString(), fee: USDC(9).toString(), refund: USDC(303).toString() }));
    expect(await bid(b0)).toMatchObject({ processed: true, allocated_units: '100', cost: USDC(900).toString(), fee: USDC(9).toString(), pending_units: '100', pending_refund: USDC(303).toString(), delivered: false });
    expect(await pos(b0)).toEqual({ units: '100', undelivered_units: '100' });
    await apply(ev('BidDelivered', { seriesId, bidder: b0, units: '100', refund: USDC(303).toString() }));
    expect(await bid(b0)).toMatchObject({ processed: true, delivered: true, delivered_units: '100', refunded: USDC(303).toString(), pending_units: '0', pending_refund: '0' });
    expect(await pos(b0)).toEqual({ units: '100', undelivered_units: '0' });
    // anyone may register any allowlisted wallet (Stage 1 register_holder): a wallet registered with no units has no
    // position, and a repeated registration keeps the first (cause S2-RH)
    const outsider = 'registered-only-wallet';
    await apply(ev('HolderRegistered', { seriesId, holder: outsider }), ev('HolderRegistered', { seriesId, holder: outsider }));
    expect(await registered(outsider)).toBe(true);
    expect(await pos(outsider)).toBeUndefined();
    expect((await t.pool.query('select count(*)::int as n from holder_registrations where series_id = $1', [seriesId])).rows[0].n).toBe(2);
    // a loser is processed without an event: its delivery marks it processed (S2 amendment M4)
    expect(await bid(b4)).toMatchObject({ processed: false, delivered: false });
    await apply(ev('BidDelivered', { seriesId, bidder: b4, units: '0', refund: USDC(909).toString() }));
    expect(await bid(b4)).toMatchObject({ processed: true, delivered: true, delivered_units: '0', refunded: USDC(909).toString() });
    expect(await pos(b4)).toBeUndefined();
    const refunds = await t.pool.query("select wallet, amount::text from money_events where series_id = $1 and kind = 'refund' order by seq", [seriesId]);
    expect(refunds.rows).toEqual([{ wallet: b0, amount: USDC(303).toString() }, { wallet: b4, amount: USDC(909).toString() }]);

    // the last process finalises the mint: every bid of the series is processed (S2 amendment M4)
    expect(await series()).toMatchObject({ mint_finalized: false });
    await apply(ev('RaiseMintFinalized', { seriesId, unitsSold: '500', proceeds: USDC(4500).toString() }));
    expect(await series()).toMatchObject({ phase: 'Settled', mint_finalized: true, units_outstanding: '500' });
    expect((await t.pool.query('select count(*)::int as n from bids where series_id = $1 and processed', [seriesId])).rows[0].n).toBe(5);

    // the public activity feed: rounds, reasons and unit counts, never an amount; registration is not in the feed
    const act = await t.pool.query('select summary from activity where chain = $1 and seq > 1000000 order by seq', [key]);
    expect(act.rows.map((r) => r.summary)).toEqual([
      'Settlement proposed (round 1)', 'Settlement round 1 rejected (ClaimMismatch)', 'Settlement proposed (round 2)', 'Auction settled: 500 units sold',
      '100 units allocated to a bidder', 'A bid was delivered', 'A bid was delivered', 'Raise minting finalised',
    ]);
  });

  // cause S2-MS, S2-PU: the engine's own settlement, step by step: the raise is Settling between begin and finalize; the
  // money moves bid by bid at processing and the units become outstanding at the last process (was: all at settlement)
  it('projects a real multi-step settlement: Settling, then the treasury per winner, the mint gate and undelivered units until delivery', async () => {
    const key = 'settle-steps';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId } = await h.runRaise({ settle: 'none' });
    const b0 = h.backers[0]!.address;
    const series = async () => (await t.pool.query('select phase, mint_finalized, units_outstanding::text, treasury_total::text, settlement_round from series where series_id = $1', [seriesId])).rows[0];
    const pos = async () => (await t.pool.query('select units::text, undelivered_units::text from positions where series_id = $1 and wallet = $2', [seriesId, b0])).rows[0];
    const money = async (kind: string) => (await t.pool.query('select amount::text from money_events where series_id = $1 and kind = $2 order by seq', [seriesId, kind])).rows.map((r) => r.amount);
    await idx.catchUp();
    // validity is fixed at reveal and projected
    expect((await t.pool.query('select valid from bids where series_id = $1 order by bid_order', [seriesId])).rows.map((r) => r.valid)).toEqual([true, true, true, true, true]);
    // the proposal alone: the raise is Settling
    await runSettlement(h.sim, seriesId, { until: 'finalize', maxSteps: 1, atLimit: 'stop' });
    await idx.catchUp();
    expect(await series()).toMatchObject({ phase: 'Settling', settlement_round: 1, mint_finalized: false });
    // finalized: Settled, but no units outstanding and no treasury until the bids are processed
    await h.settle(seriesId, 'finalize');
    await idx.catchUp();
    expect(await series()).toEqual({ phase: 'Settled', mint_finalized: false, units_outstanding: '0', treasury_total: '0', settlement_round: 1 });
    expect(await money('treasury')).toEqual([]);
    // every bid processed: the mint is final, each winner's cost funded the treasury, units count undelivered
    await h.settle(seriesId, 'process');
    await idx.catchUp();
    expect(await series()).toEqual({ phase: 'Settled', mint_finalized: true, units_outstanding: '500', treasury_total: USDC(4500).toString(), settlement_round: 1 });
    expect(await money('treasury')).toEqual(Array(5).fill(USDC(900).toString()));
    expect(await pos()).toEqual({ units: '100', undelivered_units: '100' });
    expect(await money('refund')).toEqual([]);
    // delivered: the units are the holder's own, the refunds are paid (303/202/101/101; the last winner's is 0)
    await h.settle(seriesId, 'deliver');
    await idx.catchUp();
    expect(await pos()).toEqual({ units: '100', undelivered_units: '0' });
    expect(await money('refund')).toEqual([303, 202, 101, 101].map((n) => USDC(n).toString()));
    expect((await t.pool.query('select count(*)::int as n from bids where series_id = $1 and processed and delivered', [seriesId])).rows[0].n).toBe(5);
  });

  // cause NRC: the non-reveal charge, modelled as Stage 1 does (migration 022). An unrevealed bid on a settled raise: its
  // NonRevealCharged writes the bid's charge and what it is owed, its FeeTaken{nonReveal} the fee row, its notice goes to
  // the bidder; the feed names no amount. Figures as in the simulator's own test (Stage 1's Simulator at 100 bps)
  it('projects a non-reveal charge: the bid\'s charge and refund, a nonReveal fee row, the bidder\'s notice, no amount in the feed', async () => {
    const key = 'non-reveal';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const b4 = h.backers[4]!.address;
    const bids = [...[12, 11, 10, 10].map((p, backer) => ({ backer, price: USDC(p), qty: 100n })), { backer: 4, price: USDC(9), qty: 100n, reveal: false }];
    const { seriesId } = await h.runRaise({ terms: { unitsOffered: '400', walletCapBps: 2500, minimumRaise: USDC(3200).toString(), nonRevealChargeBps: 100 }, bids, settle: 'process' });
    await idx.catchUp();
    const bid = async () => (await t.pool.query('select processed, delivered, non_reveal_charge::text, pending_refund::text, refunded::text from bids where series_id = $1 and bidder = $2', [seriesId, b4])).rows[0];
    expect(await bid()).toEqual({ processed: true, delivered: false, non_reveal_charge: USDC(9.09).toString(), pending_refund: USDC(899.91).toString(), refunded: '0' });
    expect((await t.pool.query('select bidder, non_reveal_charge::text from bids where series_id = $1 and bidder <> $2 order by bid_order', [seriesId, b4])).rows.map((r) => r.non_reveal_charge)).toEqual(['0', '0', '0', '0']);
    const fees = await t.pool.query('select kind, payer, amount::text from fees_ledger where series_id = $1 order by seq', [seriesId]);
    expect(fees.rows.filter((r) => r.kind === 'nonReveal')).toEqual([{ kind: 'nonReveal', payer: b4, amount: USDC(9.09).toString() }]);
    expect(fees.rows.filter((r) => r.kind === 'auction')).toHaveLength(4);
    const feeMoney = await t.pool.query("select wallet, amount::text, detail from money_events where series_id = $1 and kind = 'fee' and detail->>'kind' = 'nonReveal'", [seriesId]);
    expect(feeMoney.rows).toEqual([{ wallet: b4, amount: USDC(9.09).toString(), detail: { kind: 'nonReveal' } }]);
    // the feed says what happened, never how much
    const act = await t.pool.query("select summary from activity where series_id = $1 and kind = 'NonRevealCharged'", [seriesId]);
    expect(act.rows).toEqual([{ summary: 'An unrevealed bid was charged the non-reveal charge' }]);
    expect(/\d/.test(act.rows[0].summary)).toBe(false);
    // the bidder's own notice (the notifications module renders it without an amount)
    const notices = (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'chain' = $1 and payload->>'seriesId' = $2 order by id", [key, seriesId])).rows.map((r) => r.payload as Record<string, unknown>);
    expect(notices.filter((n) => n.kind === 'bid.non-reveal-charged').map((n) => [n.wallet, (n.payload as { bidder: string }).bidder])).toEqual([[b4, b4]]);
    // delivered: the rest of the deposit is the bid's refund; the charge stays on the row
    await h.settle(seriesId, 'deliver');
    await idx.catchUp();
    expect(await bid()).toEqual({ processed: true, delivered: true, non_reveal_charge: USDC(9.09).toString(), pending_refund: '0', refunded: USDC(899.91).toString() });
    const refunds = await t.pool.query("select amount::text from money_events where series_id = $1 and kind = 'refund' and wallet = $2", [seriesId, b4]);
    expect(refunds.rows).toEqual([{ amount: USDC(899.91).toString() }]);
  });

  // cause S3-KP (S3 WP11, amendment M8): a curve's own notices. Its completion is `curve.completed` (the issuer and the
  // holders) and stands for the mint notice (no bids were processed); its redemption is `curve.tender-open` (the holders:
  // redeemed by tender); every notice of a curve series names its raise style, so a status change says what a curve
  // holder sends. A sealed-bid series' notices are unchanged.
  it('enqueues a curve\'s notices: curve.completed in place of the mint notice, curve.tender-open at the redemption, each naming the raise style', async () => {
    const key = 'curve-notices';
    const h = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const notices = async (seriesId: string) => (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'chain' = $1 and payload->>'seriesId' = $2 order by id", [key, seriesId])).rows.map((r) => r.payload as Record<string, unknown>);
    const { seriesId } = await h.createCurve();
    await h.fillCurve(seriesId);
    await idx.catchUp();
    const done = await notices(seriesId);
    expect(done.map((n) => [n.kind, n.raiseStyle])).toEqual([['curve.completed', 'curve']]);
    expect(done[0]).toMatchObject({ seriesId, chain: key, payload: { seriesId, settledAt: (await h.sim.getSeries(seriesId))!.settledAt } });
    await h.registerHolder(seriesId, h.backers[0]!);
    await h.syncCurve(seriesId);
    await h.stake(seriesId, h.backers[0]!, 1_000_000n);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    await idx.catchUp();
    const redeemed = (await notices(seriesId)).slice(1);
    expect(redeemed.map((n) => [n.kind, n.raiseStyle])).toEqual([['curve.tender-open', 'curve'], ['series.StatusChanged', 'curve']]);
    expect(redeemed[1]).toMatchObject({ payload: { to: 'Redeemed' } });
    // a sealed-bid raise on the same chain: its mint notice and no raise style
    const sealed = (await h.runRaise()).seriesId;
    await idx.catchUp();
    const s = await notices(sealed);
    expect(s.map((n) => n.kind)).toContain('auction.mint-finalized');
    expect(s.every((n) => !('raiseStyle' in n) && !String(n.kind).startsWith('curve.'))).toBe(true);
  });

  // S2 WP6: the settlement's notices come from its finalized events, like every chain notice
  it('enqueues the settlement\'s notices: a rejected round, the mint finalized with its outcome, and each delivery addressed to its bidder', async () => {
    const key = 'auction-notices';
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const notices = async (seriesId: string) => (await t.pool.query("select payload from outbox where topic = 'notification' and payload->>'chain' = $1 and payload->>'seriesId' = $2 order by id", [key, seriesId])).rows.map((r) => r.payload as Record<string, unknown>);
    const { seriesId } = await h.runRaise({ settle: 'none' });
    // round 1: a wrong claim at the right price is rejected at finalize (ClaimMismatch); the keepers' honest round follows
    await h.sim.submit({ kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '99' }, 'keeper');
    await h.sim.submit({ kind: 'tallyBids', seriesId }, 'keeper');
    await h.sim.submit({ kind: 'finalizeSettlement', seriesId }, 'keeper');
    await h.settle(seriesId, 'deliver');
    await idx.catchUp();
    const settled = await notices(seriesId);
    expect(settled.map((n) => n.kind)).toEqual(['auction.settlement-rejected', 'auction.settled', 'auction.mint-finalized', ...Array(5).fill('bid.delivered')]);
    expect(settled[0]).toMatchObject({ seriesId, chain: key, payload: { seriesId, round: 1, reason: 'ClaimMismatch' } });
    expect(settled[2]).toMatchObject({ outcome: 'settled', payload: { seriesId, unitsSold: '500' } });
    // a delivery is addressed to its bidder's wallet (the notifications module routes it there and nowhere else)
    expect(settled.slice(3).map((n) => n.wallet)).toEqual(h.backers.slice(0, 5).map((w) => w.address));
    expect(settled.slice(3).every((n) => (n.payload as { bidder: string }).bidder === n.wallet)).toBe(true);
    // a failed raise: its notice, the mint finalized as failed (0, 0) and the deposit's delivery
    const failed = (await h.runRaise({ bids: [{ backer: 0, price: USDC(10), qty: 10n }] })).seriesId;
    await idx.catchUp();
    const f = await notices(failed);
    expect(f.map((n) => [n.kind, n.outcome ?? null, n.wallet ?? null])).toEqual([['auction.failed', null, null], ['auction.mint-finalized', 'failed', null], ['bid.delivered', null, h.backers[0]!.address]]);
  });

  // cause S2-FP: a failed raise keeps its price and would-be results on the auction; the issue price stays unset
  it('projects a failed raise\'s reason, price and would-be results, with no amount in the feed', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'failed-raise', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId } = await h.runRaise({ bids: [{ backer: 0, price: USDC(10), qty: 10n }] });
    await idx.catchUp();
    const row = (await t.pool.query('select phase, issue_price, auction_failure_reason, auction_clearing_price::text, auction_units_sold::text, auction_proceeds::text, auction_finalized_at is not null as finalized from series where series_id = $1', [seriesId])).rows[0];
    expect(row).toEqual({ phase: 'Failed', issue_price: null, auction_failure_reason: 'MinRaise', auction_clearing_price: USDC(10).toString(), auction_units_sold: '10', auction_proceeds: USDC(100).toString(), finalized: true });
    const act = await t.pool.query("select summary from activity where series_id = $1 and kind = 'AuctionFailed'", [seriesId]);
    expect(act.rows).toEqual([{ summary: 'Auction failed (MinRaise); deposits are returned to the bidders' }]);
  });

  // S2 review fix: a NoValidBids failure found no price. The event carries Stage 1's 0 (as the chains' RaiseFailed
  // does); the read model records null, as the chain's auction read and the API contract (SeriesAuction) do
  it('projects a NoValidBids failure (every revealed bid invalid, or no bid at all) with no clearing price', async () => {
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'novalid-raise', genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    // one bid below the reserve, one above the wallet cap: both revealed, neither valid
    const invalid = await h.runRaise({ bids: [{ backer: 0, price: 1n, qty: 10n }, { backer: 1, price: USDC(10), qty: 300n }] });
    const zero = await h.runRaise({ bids: [] });
    await idx.catchUp();
    for (const { seriesId, failureReason } of [invalid, zero]) {
      expect(failureReason).toBe('NoValidBids');
      expect((await h.sim.getAuction(seriesId))!.clearingPrice).toBeNull();
      const event = (await t.pool.query("select payload from events where chain = 'novalid-raise' and type = 'AuctionFailed' and payload->>'seriesId' = $1", [seriesId])).rows[0].payload;
      expect(event).toMatchObject({ reason: 'NoValidBids', clearingPrice: '0', unitsSold: '0', proceeds: '0' });
      const row = (await t.pool.query('select phase, issue_price, auction_failure_reason, auction_clearing_price::text, auction_units_sold::text, auction_proceeds::text, auction_finalized_at is not null as finalized from series where series_id = $1', [seriesId])).rows[0];
      expect(row).toEqual({ phase: 'Failed', issue_price: null, auction_failure_reason: 'NoValidBids', auction_clearing_price: null, auction_units_sold: '0', auction_proceeds: '0', finalized: true });
    }
    expect((await h.sim.getAuction(invalid.seriesId))).toMatchObject({ revealedCount: 2, validCount: 0 });
    expect((await h.sim.getAuction(zero.seriesId))).toMatchObject({ bidCount: 0 });
  });

  it('projects the claim family: tail and final claims as money rows above 0, positions updated never created, a burn of 0 ignored', async () => {
    const key = 'claims-family';
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    await h.sim.setTime(settledAt + 11);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    // white-box: a tail of 1.5 per unit in the vault (the tail state's accumulator, as a paid tail leaves it)
    const live = h.sim.state.series.get(seriesId)!;
    live.tail.tailAccWad = USDC(1.5) * WAD;
    live.vaultBalance += USDC(750);
    // b0: redeemed first, then its tail (150); a second claim of 0
    await h.exec(b0, { kind: 'claimTail', seriesId });
    await h.exec(b0, { kind: 'claimTail', seriesId });
    await h.sim.setTime(settledAt + 12);
    await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    // b1: redeemed first, then its final share 4.5 × 100; a second claim of 0
    await h.exec(b1, { kind: 'claimFinal', seriesId });
    await h.exec(b1, { kind: 'claimFinal', seriesId });
    await idx.catchUp();

    const rows = async (kind: string) => (await t.pool.query('select wallet, amount::text, detail from money_events where series_id = $1 and kind = $2 order by seq', [seriesId, kind])).rows;
    expect(await rows('tail_claim')).toEqual([{ wallet: b0.address, amount: USDC(150).toString(), detail: {} }]);
    expect(await rows('final_claim')).toEqual([{ wallet: b1.address, amount: USDC(450).toString(), detail: { units: '100' } }]);
    // the redemption principal is its own row; claimed_total sums what the holder was paid as payouts, tail and final
    expect((await rows('redemption_claim')).map((r) => [r.wallet, r.amount])).toEqual([[b0.address, USDC(900).toString()], [b1.address, USDC(900).toString()]]);
    const pos = async (w: string) => (await t.pool.query('select units::text, redeemed_units::text, claimed_total::text from positions where series_id = $1 and wallet = $2', [seriesId, w])).rows[0];
    expect(await pos(b0.address)).toEqual({ units: '0', redeemed_units: '100', claimed_total: USDC(150).toString() });
    expect(await pos(b1.address)).toEqual({ units: '0', redeemed_units: '100', claimed_total: USDC(450).toString() });
    // the public feed names no amount
    const act = (await t.pool.query("select kind, summary from activity where series_id = $1 and kind in ('TailClaimed', 'FinalClaimed') order by seq", [seriesId])).rows;
    expect(act).toEqual([
      { kind: 'TailClaimed', summary: 'A holder claimed its tail payout' }, { kind: 'TailClaimed', summary: 'A holder claimed its tail payout' },
      { kind: 'FinalClaimed', summary: 'A holder claimed its final-pool share' }, { kind: 'FinalClaimed', summary: 'A holder claimed its final-pool share' },
    ]);

    // a claim by a wallet with no position (a registration alone, A-REV-10) creates none, and a burn of 0 changes nothing
    let seq = 2_000_000;
    const ev = <T extends EventType>(type: T, payload: EventPayload<T>): DomainEvent => ({ chain: key, cursor: String(++seq).padStart(12, '0'), seq, blockTime: 1_780_000_000, blockRef: String(seq), txId: `synthetic-${seq}`, finality: 'finalized', type, payload }) as DomainEvent;
    const outsider = 'registered-only-claimer';
    const c = await t.pool.connect();
    try {
      await c.query('begin');
      for (const e of [
        ev('TailClaimed', { seriesId, holder: outsider, amount: '0' }),
        ev('FinalClaimed', { seriesId, holder: outsider, units: '0', amount: '0' }),
        ev('UnitsBurned', { seriesId, holder: outsider, units: '0', reason: 'cap' }),
      ]) await project(c, e);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await pos(outsider)).toBeUndefined();
    expect((await t.pool.query('select count(*)::int as n from money_events where series_id = $1 and wallet = $2', [seriesId, outsider])).rows[0].n).toBe(0);
    expect((await t.pool.query('select units_outstanding::text from series where series_id = $1', [seriesId])).rows[0].units_outstanding).toBe('300');
    // anyone may send a burn of 0 for any wallet: it adds no line to the public feed
    expect((await t.pool.query("select count(*)::int as n from activity where chain = $1 and seq > 2000000 and kind = 'UnitsBurned'", [key])).rows[0].n).toBe(0);
  });

  it('projects PayoutClaimed: positions updated never created, money rows above 0 only, the units burned noted (S3-IX)', async () => {
    const key = 'payout-claims';
    const h = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: key, genesis: GENESIS, acceptMockProofs: true }) });
    const idx = new Indexer(t.pool, [h.sim], { logger: quiet });
    const raise = await h.runRaise();
    const { seriesId } = raise;
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    // a wallet that is only registered (anyone may register any allowlisted wallet) and claims nothing
    const late = new SimWallet(h.sim.family, 'registered-only-holder');
    await h.sim.submit({ kind: 'setAllowlist', wallet: late.address, allowed: true }, 'allowlistManager');
    await h.sim.submit({ kind: 'registerHolder', seriesId, wallet: late.address }, 'keeper');
    const zero = await h.exec(late, { kind: 'claimPayout', seriesId });
    expect(zero.events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: late.address, amount: '0', burnedUnits: '0' }]]);
    // the cap is met: b0's claim pays and burns its 100 units; b1's units burn first, so its claim pays only; b1 then
    // claims again: nothing paid, nothing burned
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(200_000));
    await h.exec(b0, { kind: 'claimPayout', seriesId });
    await h.sim.submit({ kind: 'burnRetired', seriesId, holder: b1.address }, 'keeper');
    await h.exec(b1, { kind: 'claimPayout', seriesId });
    await h.exec(b1, { kind: 'claimPayout', seriesId });
    await h.exec(late, { kind: 'claimPayout', seriesId });
    await idx.catchUp();

    const share = (USDC(11_250) * 95n / 100n / 5n).toString();
    const rows = (await t.pool.query("select wallet, amount::text, detail from money_events where series_id = $1 and kind = 'payout' order by seq", [seriesId])).rows;
    expect(rows).toEqual([{ wallet: b0.address, amount: share, detail: { burnedUnits: '100' } }, { wallet: b1.address, amount: share, detail: { burnedUnits: '0' } }]);
    const pos = async (w: string) => (await t.pool.query('select units::text, burned_units::text, claimed_total::text from positions where series_id = $1 and wallet = $2', [seriesId, w])).rows[0];
    expect(await pos(b0.address)).toEqual({ units: '0', burned_units: '100', claimed_total: share });
    expect(await pos(b1.address)).toEqual({ units: '0', burned_units: '100', claimed_total: share });
    // the registered-only wallet: a registration, no position and no money row, whatever it claimed
    expect(await pos(late.address)).toBeUndefined();
    expect((await t.pool.query('select 1 from holder_registrations where series_id = $1 and wallet = $2', [seriesId, late.address])).rowCount).toBe(1);
    expect((await t.pool.query('select count(*)::int as n from money_events where series_id = $1 and wallet = $2', [seriesId, late.address])).rows[0].n).toBe(0);
    expect((await t.pool.query('select units_outstanding::text from series where series_id = $1', [seriesId])).rows[0].units_outstanding).toBe('300');
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

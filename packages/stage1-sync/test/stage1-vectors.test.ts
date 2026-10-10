import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainError } from '@merces/domain';
import type { Step } from '@merces/reference';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DIVERGENCES,
  DIVERGENCE_BY_ID,
  EXPECTED,
  MercesWorld,
  NOT_YET,
  PREFIX_GATES,
  ReferenceWorld,
  TRANSLATORS,
  SHIMS,
  SHIM_BY_ID,
  TARGETS,
  TARGETS_S1,
  TARGETS_S2,
  atExpected,
  isFinding,
  splitDivergences,
  backendAvailable,
  checkRevert,
  compareExpect,
  fromJson,
  listVectorFiles,
  loadVector,
  opLabel,
  renderParity,
  renderSummary,
  replayLockstep,
  replayVector,
  runStage1Vectors,
  shutdown,
  waiverFor,
  type Divergence,
  type LoadedVector,
  type LockstepDivergence,
  type RunReport,
  type Shim,
  type SyntheticShims,
  type World,
} from '../src/stage1-vectors/index.ts';
import { STAGE1_OP_MAP } from '../src/steps/vectors.ts';

const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const raw = (name: string) => JSON.parse(readFileSync(join(VECTORS, `${name}.json`), 'utf8')) as Record<string, unknown> & { steps: Record<string, unknown>[] };
const vectorFile = (id: string) => listVectorFiles(VECTORS).find((f) => f.split('/').at(-1)!.startsWith(`${id}_`))!;

/*
 * S2 cause codes:
 *  - S2-CR: Stage 1's creation rules over the raise's own terms (commit and reveal durations, the non-reveal charge),
 *    canonical since S2; `open_raise` runs directly (shim SH-AUC-1 retired);
 *  - S2-VR: a bid's validity is fixed at reveal (Stage 1 `isBidValid`): an over-cap bid is invalid and refunded in full;
 *  - S2-MS: Stage 1's multi-step settlement runs directly (begin, tally and finalize, process, deliver; shims
 *    SH-AUC-3..6 retired, the auction and holder views come from the engine);
 *  - S2-RH: `register_holder` runs directly (with `cancel_raise`, no longer outside the milestone);
 *  - S2-NY: the vectors and ops that need a later milestone are NOT-YET (was NOT-IN-S1); the targets are S1's and S2's,
 *    the prefix-gated vectors replay to their gate, and the runner's wording follows ("is not modelled yet (S5)");
 *  - S2-LS: lockstep compares every step of a raise's settlement (only a window mid-settlement is skipped until S5).
 *
 * S3 cause codes:
 *  - S3-SH: `claim_tail`, `claim_final` and `burn_retired` run directly as `claimTail`, `claimFinal` and `burnRetired`
 *    (shims SH-CLM-2, SH-CLM-3 and SH-BRN-1 retired); no row of the shim table is runner-atomic any more, so the
 *    runner-atomic mechanism is tested on a synthetic row; 22 stays gated at #75 by its windows (milestone S5).
 *
 * S3 follow-up cause code:
 *  - NRC: the non-reveal charge is modelled as Stage 1 models it: 03 is PASS in full on both personalities and in
 *    lockstep, and the divergence register is empty (was: DIV-NRC-1, the S2 hold, with five fields of 03 and its lockstep
 *    parting at #65). The divergence mechanism stays; it is tested on a test-only divergence (`TEST_03`).
 */
afterAll(shutdown);

/**
 * A test-only divergence, since the register is empty: vector 03 replayed with its S1 created at 0 bps on the merces
 * side only (`ZERO_CHARGE`, a synthetic create_series), so b8, which never reveals, is refunded in full and five
 * `expect` fields differ from Stage 1's at the vector's 1%. The values are Stage 1's own arithmetic: its simulator at
 * 0 bps reaches exactly them (tested below). They are the former DIV-NRC-1 entries.
 */
const TEST_ID = 'DIV-TEST-1';
const TEST_03: Divergence[] = [
  { id: TEST_ID, step: 67, path: 'auction.escrowTotal', stage1: '55925700000', ours: '56026700000' },
  { id: TEST_ID, step: 67, path: 'auctionEscrow', stage1: '55925700000', ours: '56026700000' },
  { id: TEST_ID, step: 67, path: 'feeCollector', stage1: '428800000', ours: '327800000' },
  { id: TEST_ID, step: 77, path: 'balances.b8.stable', stage1: '29899000000', ours: '30000000000' },
  { id: TEST_ID, step: 77, path: 'feeCollector', stage1: '428800000', ours: '327800000' },
];
/** Where lockstep parts with `ZERO_CHARGE`: right after `process_bid b8` (#65). */
const TEST_03_LOCKSTEP: LockstepDivergence = {
  id: TEST_ID,
  divergesAt: 65,
  diffs: [
    { path: 'S1.auction.escrowTotal', stage1: '55925700000', ours: '56026700000' },
    { path: 'S1.auctionEscrow', stage1: '55925700000', ours: '56026700000' },
    { path: 'S1.feeCollector', stage1: '428800000', ours: '327800000' },
  ],
};
/** The merces backend creates every series at 0 bps (the vector's own create_series otherwise). */
const ZERO_CHARGE: SyntheticShims = {
  rows: [],
  translators: { create_series: (ctx, c) => TRANSLATORS.create_series!(ctx, { ...c, terms: { ...c.terms, nonRevealChargeBps: '0' } }) },
};

describe('stage1 vector runner: reference backend', () => {
  let report: RunReport;

  it('replays all 25 Stage 1 vectors on Stage 1\'s own simulator with proofs verified', async () => {
    report = await runStage1Vectors({ dir: VECTORS, backend: 'reference' });
    expect(report.runs.map((r) => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(2, '0')));
    for (const r of report.runs) {
      expect(r.issues, r.vector).toEqual([]);
      expect(r.status, r.vector).toBe('PASS');
      expect(r.executed).toBe(r.total);
    }
    expect(report.ok).toBe(true);
    // the vectors embed 173 report calls; the distinct (proof, signals) pairs are each verified once, and exactly the
    // deliberate tamper cases fail
    expect(report.proofs.verified).toBeGreaterThan(150);
    expect(report.proofs.invalid).toBe(3);
  }, 120_000);

  it('the parity report carries public values only (privacy canary)', () => {
    expect(report).toBeDefined();
    const secrets = new Set<string>();
    for (const f of listVectorFiles(VECTORS)) {
      const v = JSON.parse(readFileSync(f, 'utf8')) as {
        keys: Record<string, { privateKey: string }>;
        seriesPrivate: Record<string, { termsPlain: { termsSalt: string } }>;
        steps: { op: string; call?: { op: string; witness?: Record<string, string> }; witness?: Record<string, string> }[];
      };
      for (const k of Object.values(v.keys)) secrets.add(k.privateKey.toLowerCase()).add(k.privateKey.slice(2).toLowerCase());
      for (const s of Object.values(v.seriesPrivate)) secrets.add(s.termsPlain.termsSalt);
      for (const s of v.steps) {
        const w = (s.op === 'expect_revert' ? s.call?.witness : s.witness) ?? {};
        for (const salt of [w.incomeSalt, w.priorSalt]) if (salt && salt !== '0') secrets.add(salt);
      }
    }
    expect(secrets.size).toBeGreaterThan(50);
    const md = renderParity([report], { dir: '$STAGE1_PATH/packages/vectors' }).toLowerCase();
    const json = JSON.stringify(report).toLowerCase();
    for (const s of secrets) {
      expect(md.includes(s)).toBe(false);
      expect(json.includes(s)).toBe(false);
    }
  });
});

describe('stage1 vector runner: load', () => {
  it('drops witness (top level and inside expect_revert) and seriesPrivate; keys are kept but never enumerable', () => {
    const v = loadVector(join(VECTORS, '04_zero_quarters.json'));
    expect(v.id).toBe('04');
    expect(v.privateSeries).toEqual(['S1', 'S2']);
    const text = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
    expect(text).not.toContain('witness');
    expect(text).not.toContain('termsSalt');
    expect(text).not.toContain('privateKey');
    expect(Object.keys(v)).not.toContain('keys');
    expect(v.keys.attestor1?.role).toBe('attestor');
    // the source object is left alone
    const src = raw('04_zero_quarters');
    fromJson(src, '04_zero_quarters');
    expect(JSON.stringify(src)).toContain('"witness"');
  });

  it('refuses another schema, another spec version and non-default parameters, naming the keys', () => {
    const src = raw('01_happy_path');
    expect(() => fromJson({ ...src, schema: 1 }, '01_happy_path')).toThrow(/schema 1 is not 2/);
    expect(() => fromJson({ ...src, specVersion: '1.0' }, '01_happy_path')).toThrow(/specVersion "1.0" is not 1.1/);
    const config = src.config as { parameters: Record<string, string> };
    const params = { ...config.parameters, payout_fee_bps: '400', grace_days: '16' };
    expect(() => fromJson({ ...src, config: { ...config, parameters: params } }, '01_happy_path')).toThrow(/differ from Stage 1's DEFAULT_PARAMETERS at graceDays, payoutFeeBps|at payoutFeeBps, graceDays/);
    const { report_due_days: _gone, ...missing } = config.parameters;
    expect(() => fromJson({ ...src, config: { ...config, parameters: missing } }, '01_happy_path')).toThrow(/missing parameter report_due_days/);
  });
});

describe('stage1 vector runner: checks are not vacuous', () => {
  const replay = (v: LoadedVector, until?: number) => runStage1Vectors({ vectors: [v], backend: 'reference', ...(until !== undefined ? { until } : {}) });

  it('proof verification is real: a valid proof bound to other signals is InvalidProof', async () => {
    const src = raw('04_zero_quarters');
    const i = src.steps.findIndex((s) => s.op === 'submit_report');
    const first = src.steps[i]!;
    const other = src.steps.find((s) => s.op === 'submit_report' && JSON.stringify(s.proof) !== JSON.stringify(first.proof))!;
    first.proof = other.proof;
    const r = (await replay(fromJson(src, '04_zero_quarters'), i)).runs[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.issues).toEqual([{ index: i, op: 'submit_report', kind: 'fail', message: 'unexpected revert InvalidProof' }]);
  }, 60_000);

  it('a changed expect value fails at its path, and the replay goes on', async () => {
    const src = raw('01_happy_path');
    const i = src.steps.findIndex((s) => s.op === 'expect' && s.balances);
    const balances = src.steps[i]!.balances as Record<string, { stable: string }>;
    const [name, entry] = Object.entries(balances)[0]!;
    entry.stable = String(BigInt(entry.stable) + 1n);
    const r = (await replay(fromJson(src, '01_happy_path'))).runs[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.executed).toBe(r.total);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.index).toBe(i);
    expect(r.issues[0]!.diffs).toEqual([{ path: `balances.${name}.stable`, expected: entry.stable, actual: String(BigInt(entry.stable) - 1n) }]);
    expect(atExpected(r, EXPECTED['01']!)).toBe(false);
  }, 60_000);

  it('expect_revert: the error name must match (aliases accepted) and a call that goes through fails', async () => {
    const src = raw('05_cap_hit');
    const i = src.steps.findIndex((s) => s.op === 'expect_revert' && s.error === 'TerminalStatus');
    expect(i).toBeGreaterThan(0);
    src.steps[i]!.error = 'SeriesTerminal'; // the v1.0 name (ERROR_ALIASES)
    expect((await replay(fromJson(src, '05_cap_hit'), i)).runs[0]!.status).toBe('PASS');
    src.steps[i]!.error = 'NothingDue';
    const wrong = (await replay(fromJson(src, '05_cap_hit'), i)).runs[0]!;
    expect(wrong.issues.map((x) => x.message)).toEqual([`expected revert NothingDue for ${(src.steps[i]!.call as { op: string }).op}, got TerminalStatus`]);
    // a step that succeeds on Stage 1, wrapped as an expected revert
    const ok = src.steps.findIndex((s) => s.op === 'claim');
    src.steps[ok] = { t: src.steps[ok]!.t, op: 'expect_revert', call: { ...src.steps[ok]! }, error: 'NothingDue' };
    delete (src.steps[ok]!.call as { t?: string }).t;
    const through = (await replay(fromJson(src, '05_cap_hit'), ok)).runs[0]!;
    expect(through.issues.at(-1)!.message).toMatch(/expected revert NothingDue for claim, but the call succeeded/);
    expect(through.status).toBe('FAIL');
  }, 60_000);

  it('a revert that changes the state fails, even when the world restores it afterwards, and a non-protocol exception is reported by class only', async () => {
    const v = loadVector(join(VECTORS, '01_happy_path.json'));
    const step = v.steps.find((s) => s.op === 'expect_revert')!;
    if (step.op !== 'expect_revert') throw new Error('unreachable');
    let state = 'a';
    /** `mutate`: the failing call changes the state; `restore`: the world then puts it back, as the merces world does */
    const fake = (thrown: unknown, mutate: boolean, restore = false): World => ({
      backend: 'reference',
      label: 'fake',
      setTime: () => {},
      apply: async () => {
        throw thrown;
      },
      attempt: async () => {
        const before = state;
        if (mutate) state = 'b';
        const leaked = state !== before;
        if (restore) state = before;
        return { ok: false, error: thrown, applied: { kind: 'direct' }, leaked, rolledBack: 0 };
      },
      classify: (e) => new ReferenceWorld(v).classify(e),
      snapshot: () => ({}),
      serialize: () => state,
      totalStable: () => 0n,
      checkUnitSupply: () => {},
      close: async () => {},
    });
    const { SimError } = await import('@merces/reference');
    const changed = await checkRevert(fake(new SimError(step.error, 'detail'), true), step);
    expect(changed).toEqual({ result: 'fail', message: `${step.call.op} reverted with ${step.error} but changed the state`, diverged: true });
    state = 'a';
    // the comparison is made before the world's rollback: a restored leak still fails, and the replay can go on
    const restored = await checkRevert(fake(new SimError(step.error, 'detail'), true, true), step);
    expect(restored).toEqual({ result: 'fail', message: `${step.call.op} reverted with ${step.error} but changed the state`, diverged: false });
    expect(state).toBe('a');
    const clean = await checkRevert(fake(new SimError(step.error, 'detail'), false), step);
    expect(clean).toEqual({ result: 'ok', applied: { kind: 'direct' }, rolledBack: 0 });
    const secret = 'income 123456789 salt 987654321';
    const other = await checkRevert(fake(new TypeError(secret), false), step);
    expect(other).toEqual({ result: 'fail', message: `expected revert ${step.error} for ${step.call.op}, got a non-protocol exception TypeError`, diverged: false });
  });
});

describe('stage1 vector runner: compare', () => {
  it('compares only the keys the step carries, each whole, ignoring key order', () => {
    const snap = { balances: { a: { stable: '1', units: '0' }, b: { units: '2', stable: '3' } }, feeCollector: '5', vault: '9' };
    expect(compareExpect({ op: 'expect', t: '1', series: 'S1', note: 'x', balances: { b: { stable: '3', units: '2' }, a: { stable: '1', units: '0' } }, feeCollector: '5' }, snap)).toEqual([]);
    expect(compareExpect({ op: 'expect', balances: { a: { stable: '1', units: '0' } } }, snap)).toEqual([{ path: 'balances.b', expected: '<absent>', actual: { units: '2', stable: '3' } }]);
    expect(compareExpect({ op: 'expect', balances: { a: { stable: '1' }, b: { units: '2', stable: '3' } } }, snap)).toEqual([{ path: 'balances.a.units', expected: '<absent>', actual: '0' }]);
    expect(compareExpect({ op: 'expect', treasury: '0' }, snap)).toEqual([{ path: 'treasury', expected: '0', actual: '<absent>' }]);
    expect(compareExpect({ op: 'expect', ledger: { lastPaidPeriod: null } }, { ledger: { lastPaidPeriod: '8104' } })).toEqual([{ path: 'ledger.lastPaidPeriod', expected: null, actual: '8104' }]);
  });
});

describe('stage1 vector runner: expectations and the op map', () => {
  // cause S2-NY, S2-MS: the targets are S1's and S2's; the vectors that need a later milestone are prefix-gated or
  // NOT-YET (was: S1 targets PASS, every other vector NOT-IN-S1). Cause NRC: no vector carries a divergence (was: 03's
  // five DIV-NRC-1 entries and its lockstep parting)
  it('targets are never NOT-YET; waivers only on blocked or n/a rows; no divergence anywhere; prefix gates carry until; the rest are NOT-YET with a milestone', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(listVectorFiles(VECTORS).map((f) => f.split('/').at(-1)!.slice(0, 2)));
    expect([...TARGETS]).toEqual([...TARGETS_S1, ...TARGETS_S2]);
    expect([...TARGETS_S2]).toEqual(['02', '03', '15', '17']);
    expect(PREFIX_GATES).toEqual({ '08': 33, '10': 35, '14': 61, '16': 40, '20': 70, '21': 40, '22': 75 });
    for (const [id, e] of Object.entries(EXPECTED)) {
      const v = loadVector(vectorFile(id));
      if (TARGETS.includes(id)) {
        expect(['PASS', 'PASS-WITH-WAIVERS', 'PASS-WITH-DIVERGENCES'], id).toContain(e.status);
        expect(e.until, id).toBeUndefined();
        for (const w of e.waivers ?? []) {
          const row = SHIM_BY_ID.get(w.id);
          expect(['blocked', 'n/a'], `${id}#${w.step}`).toContain(row?.kind);
          // the step the waiver names is that op in the vector, and the row stands for that op
          expect(opLabel(v.steps[w.step]!), `${id}#${w.step}`).toBe(w.op);
          expect(row?.ops, `${id}#${w.step}`).toContain(w.op.replace(/^expect_revert /, ''));
        }
      } else if (e.status === 'PREFIX-PASS') {
        expect(e.until, id).toBe(PREFIX_GATES[id]);
        expect(e.until!, id).toBeLessThan(v.steps.length - 1);
        expect(!!e.milestone && !!e.next, id).toBe(true);
        // the step after the gate is the one `next` names
        expect(e.next!, id).toContain(`#${e.until! + 1} \`${opLabel(v.steps[e.until! + 1]!)}\``);
      } else expect(e.status === 'NOT-YET' && !!e.milestone, id).toBe(true);
      // no divergence anywhere, and no PASS-WITH-DIVERGENCES status
      expect([e.divergences, e.lockstep], id).toEqual([undefined, undefined]);
      expect(e.status, id).not.toBe('PASS-WITH-DIVERGENCES');
    }
    // the register is empty: DIV-NRC-1 went with the non-reveal charge modelled, and 03 is PASS
    expect(DIVERGENCES).toEqual([]);
    expect(DIVERGENCE_BY_ID.size).toBe(0);
    expect(EXPECTED['03']).toMatchObject({ status: 'PASS' });
    // the test-only divergence's Stage 1 values are vector 03's own, each at an expect step; its parting is b8's process_bid
    const v03 = loadVector(vectorFile('03'));
    for (const d of TEST_03) {
      const step = v03.steps[d.step] as unknown as Record<string, unknown>;
      expect(step.op).toBe('expect');
      expect(d.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], step), d.path).toBe(d.stage1);
    }
    expect([opLabel(v03.steps[65]!), (v03.steps[65] as unknown as { bidder: string }).bidder]).toEqual(['process_bid', 'b8']);
    // cause S3-SH: the claims 22 waits for run since S3 WP2; only its windows (#76 on) wait, for S5 (was: 'S3 + S5')
    expect(EXPECTED['22']).toMatchObject({ until: 75, milestone: 'S5', reason: 'multi-step windows (#76); its claim steps #88-#110 run once windows land' });
    const v22 = loadVector(vectorFile('22'));
    // the redemption and claim part of 22 is #88 (redeem) to its last step, #110, all past the gate
    const claimSteps = v22.steps.flatMap((st, i) => (['redeem', 'claim_redemption', 'claim_tail', 'register_holder', 'extinguish', 'claim_final'].includes(st.op === 'expect_revert' ? st.call.op : st.op) ? [i] : []));
    expect([claimSteps[0], claimSteps.at(-1), v22.steps.length - 1]).toEqual([88, 109, 110]);
  });

  it('a divergence is accepted only as recorded: another value at its path fails, and an entry that no longer differs is stale', () => {
    const entries = TEST_03;
    const at67 = [
      { path: 'auction.escrowTotal', expected: '55925700000', actual: '56026700000' },
      { path: 'auctionEscrow', expected: '55925700000', actual: '56026700000' },
      { path: 'feeCollector', expected: '428800000', actual: '327800000' },
    ];
    expect(splitDivergences(entries, 67, at67)).toEqual({ accepted: at67.map((d) => ({ ...d, id: TEST_ID })), failed: [], moved: [], stale: [] });
    // ours moved (a charge of 1 USDC, say), and an unrelated field differs too
    const moved = [{ ...at67[0]! }, { ...at67[1]! }, { path: 'feeCollector', expected: '428800000', actual: '328800000' }, { path: 'treasury', expected: '1', actual: '2' }];
    const split = splitDivergences(entries, 67, moved);
    expect(split.accepted.map((d) => d.path)).toEqual(['auction.escrowTotal', 'auctionEscrow']);
    expect(split.failed.map((d) => d.path)).toEqual(['feeCollector', 'treasury']);
    expect(split.moved).toEqual(['feeCollector']);
    // the behaviour fixed: the field matches Stage 1, so its entry is stale
    expect(splitDivergences(entries, 67, at67.slice(0, 2)).stale.map((d) => d.path)).toEqual(['feeCollector']);
    // entries of another step are not consulted
    expect(splitDivergences(entries, 77, at67.slice(0, 2))).toMatchObject({ accepted: [], failed: at67.slice(0, 2), moved: [], stale: [{ path: 'balances.b8.stable' }, { path: 'feeCollector' }] });
  });

  // review finding "Waivers match any shim-less BLOCKED op at a waived step index": the id was compared only when the
  // op carried a shim row, so any op outside S1 (no row) landing on 01#32, 01#34 or 05#42 was waived
  it('a waiver covers only its own step, op and row', () => {
    const w = EXPECTED['01']!.waivers!;
    const step = (op: string, revert = true): Step => (revert ? { t: '0', op: 'expect_revert', call: { op }, error: 'X' } : { t: '0', op }) as unknown as Step;
    expect(waiverFor(w, 34, step('retire_if_capped'), { kind: 'blocked', shimId: 'BLK-1' })).toEqual({ step: 34, op: 'expect_revert retire_if_capped', id: 'BLK-1' });
    expect(waiverFor(w, 32, step('transfer_units'), { kind: 'n/a', shimId: 'NA-1' })).toEqual({ step: 32, op: 'expect_revert transfer_units', id: 'NA-1' });
    // an op outside S1 carries no row: never waived, at a waived index or anywhere
    expect(waiverFor(w, 34, step('end_pause'), { kind: 'blocked' })).toBeUndefined();
    expect(waiverFor(w, 32, step('end_pause'), { kind: 'blocked' })).toBeUndefined();
    // the same row at another index, or the op as an action instead of inside expect_revert
    expect(waiverFor(w, 33, step('retire_if_capped'), { kind: 'blocked', shimId: 'BLK-1' })).toBeUndefined();
    expect(waiverFor(w, 34, step('retire_if_capped', false), { kind: 'blocked', shimId: 'BLK-1' })).toBeUndefined();
    // another row's waiver at the index, a row that does not stand for the op, a kind the row does not have
    expect(waiverFor(w, 32, step('retire_if_capped'), { kind: 'blocked', shimId: 'BLK-1' })).toBeUndefined();
    expect(waiverFor(w, 34, step('end_pause'), { kind: 'blocked', shimId: 'BLK-1' })).toBeUndefined();
    expect(waiverFor(w, 34, step('retire_if_capped'), { kind: 'n/a', shimId: 'BLK-1' })).toBeUndefined();
    expect(waiverFor(undefined, 34, step('retire_if_capped'), { kind: 'blocked', shimId: 'BLK-1' })).toBeUndefined();
  });

  it('every op the vectors use is mapped, and every shim the map names is a row for that op', () => {
    for (const f of listVectorFiles(VECTORS)) {
      for (const s of loadVector(f).steps) {
        const op = s.op === 'expect_revert' ? s.call.op : s.op;
        expect(STAGE1_OP_MAP[op], op).toBeDefined();
      }
    }
    for (const [op, m] of Object.entries(STAGE1_OP_MAP)) {
      if (m.kind === 'shim' || m.kind === 'blocked' || m.kind === 'n/a') expect(SHIM_BY_ID.get(m.shim!)?.ops, op).toContain(op);
      if (m.kind === 'not-yet') expect(m.milestone, op).toBeTruthy();
    }
  });

  it('both backends are available', () => {
    expect(backendAvailable('reference')).toBe(true);
    expect(backendAvailable('merces')).toBe(true);
  });
});

describe('stage1:vectors CLI', () => {
  it('replays a prefix on the reference backend, writes VECTOR_PARITY.md and exits', () => {
    const out = mkdtempSync(join(tmpdir(), 'vectors-'));
    const stdout = execFileSync(join(ROOT, 'node_modules/.bin/tsx'), ['packages/stage1-sync/src/stage1-vectors/cli.ts', '--backend', 'reference', '--only', '04,7', '--until', '40', '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(stdout).toMatch(/04_zero_quarters \[reference\] PASS 41\/81, stopped at #41 \(until\)/);
    expect(stdout).toMatch(/OK: 2\/2 PASS/);
    expect(existsSync(join(out, 'VECTOR_PARITY.md'))).toBe(true);
    let code = 0;
    try {
      execFileSync(join(ROOT, 'node_modules/.bin/tsx'), ['packages/stage1-sync/src/stage1-vectors/cli.ts', '--backend', 'nope'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// merces backend (S1 WP9b): our SimulatorChain through the translators and the shim table
// ---------------------------------------------------------------------------------------------------------------

/**
 * The ops of the bootstrap and of the raise (Stage 1's settlement steps, `cancel_raise` and `register_holder` since S2);
 * a vector's raise prefix ends before the first other op, an expected revert counting as its call's op.
 */
const RAISE_PREFIX_OPS = new Set(['register_attestor', 'register_verifier_key', 'allowlist', 'register_issuer', 'fund', 'create_series', 'open_raise', 'cancel_raise', 'commit_bid', 'reveal_bid', 'begin_settlement', 'finalize_settlement', 'process_bid', 'deliver_bid', 'register_holder', 'expect']);
function raisePrefixEnd(v: LoadedVector): number {
  const i = v.steps.findIndex((s) => !RAISE_PREFIX_OPS.has(s.op === 'expect_revert' ? s.call.op : s.op));
  return i < 0 ? v.steps.length - 1 : i - 1;
}

describe('stage1 vector runner: merces backend', () => {
  it('acceptance: 01 and 04 pass through the settled expect at #31 on both personalities', async () => {
    const r = await runStage1Vectors({ dir: VECTORS, backend: 'merces', only: ['01', '04'], until: 31, personalities: ['solana', 'monad'] });
    expect(r.runs.map((x) => `${x.id}/${x.world}`)).toEqual(['01/merces/solana', '01/merces/monad', '04/merces/solana', '04/merces/monad']);
    for (const run of r.runs) {
      expect(run.issues, `${run.vector} ${run.world}`).toEqual([]);
      expect(run.status).toBe('PASS');
      expect(run.executed).toBe(32);
      expect(run.stopped).toEqual({ index: 32, reason: 'until' });
      // cause S2-MS: only the commitment is still a shim (SH-AUC-2, S4); the settlement steps run directly
      expect(run.shims['SH-AUC-2']).toBeGreaterThan(0);
      expect(Object.keys(run.shims).filter((id) => id.startsWith('SH-AUC-'))).toEqual(['SH-AUC-2']);
    }
    expect(r.ok).toBe(true);
  }, 120_000);

  // cause S2-MS: the raise prefixes of the S2 targets (begin, tally and finalize, process, deliver, their reverts,
  // cancel_raise and register_holder) replay on the merces backend too (was: the S1 targets only)
  it('every target replays its raise prefix (bootstrap, every raise and its reverts, settled expects) without a finding on both personalities', async () => {
    for (const id of TARGETS) {
      const v = loadVector(vectorFile(id));
      const until = raisePrefixEnd(v);
      expect(until, id).toBeGreaterThan(19);
      const r = await runStage1Vectors({ vectors: [v], backend: 'merces', until });
      expect(r.runs).toHaveLength(2);
      for (const run of r.runs) {
        // 01#32 and #34 lie past its prefix; 03's prefix is the whole vector (cause NRC: b8's charge included, without a
        // divergence; was: its DIV-NRC-1 entries reached and accepted)
        expect(run.issues, `${run.vector} ${run.world}`).toEqual([]);
        expect(run.executed, `${run.vector} ${run.world}`).toBe(until + 1);
        expect(run.atExpected, `${run.vector} ${run.world}`).toBe(true);
      }
    }
  }, 120_000);

  // cause S2-LS: lockstep compares every step of the settlement (was: only outside Stage 1's multi-step settlement, so
  // the full snapshots agreed after each raise prefix but were never compared between begin_settlement and the last
  // process_bid). Cause NRC: 03 too, in full (was: up to #64, parting at b8's charge)
  it('lockstep: the full snapshots of both backends agree after every step of every target, mid-settlement included (03 in full)', async () => {
    for (const id of TARGETS) {
      const v = loadVector(vectorFile(id));
      const r = await runStage1Vectors({ vectors: [v], backend: 'lockstep', personalities: ['monad'] });
      const run = r.runs[0]!;
      expect(run.world).toBe('lockstep/monad');
      expect(run.issues.filter(isFinding), v.name).toEqual([]);
      expect(run.executed, v.name).toBe(v.steps.length);
      expect(run.atExpected, v.name).toBe(true);
    }
  }, 120_000);

  // cause NRC (was: 03 parted after #65 on the DIV-NRC-1 fields, as recorded): b8's charge at process_bid agrees on both
  // backends, and 03 passes in lockstep on both personalities
  it('lockstep: 03 agrees through b8\'s charge at process_bid (#65) and passes in full on both personalities', async () => {
    const r = await runStage1Vectors({ dir: VECTORS, backend: 'lockstep', only: ['03'], personalities: ['solana', 'monad'] });
    for (const run of r.runs) {
      expect([run.status, run.executed, run.total, run.stopped, run.issues, run.atExpected], run.world).toEqual(['PASS', 78, 78, undefined, [], true]);
    }
    expect(renderSummary([r])).toContain('03_auction_edges [lockstep/solana] PASS 78/78');
  }, 120_000);

  // the lockstep side of the divergence mechanism, on the test-only divergence (the merces backend creates 03's S1 at 0
  // bps): a parting exactly as recorded is accepted; another value fails; a recorded parting that does not happen is stale
  it('lockstep accepts a recorded parting only as recorded (test-only divergence: 03 at 0 bps on the merces side)', async () => {
    const v = loadVector(vectorFile('03'));
    const parted = await replayLockstep(v, 'solana', { lockstep: TEST_03_LOCKSTEP, synthetic: ZERO_CHARGE });
    expect(parted.status).toBe('PASS-WITH-DIVERGENCES');
    expect(parted.stopped).toEqual({ index: 66, reason: 'diverged' });
    expect(parted.issues).toEqual([
      {
        index: 65,
        op: 'process_bid',
        kind: 'divergence',
        divergence: TEST_ID,
        message: `diverged at #65 as recorded (${TEST_ID}: 3 field(s); accepted, not parity)`,
        diffs: [
          { path: 'S1.auction.escrowTotal', expected: '55925700000', actual: '56026700000' },
          { path: 'S1.auctionEscrow', expected: '55925700000', actual: '56026700000' },
          { path: 'S1.feeCollector', expected: '428800000', actual: '327800000' },
        ],
      },
    ]);
    const expected = { status: 'PASS-WITH-DIVERGENCES' as const, lockstep: TEST_03_LOCKSTEP };
    expect(atExpected(parted, expected)).toBe(true);
    const summary = renderSummary([{ backend: 'lockstep', runs: [{ ...parted, expected, atExpected: true }], notRun: [], proofs: { verified: 0, invalid: 0, cacheHits: 0 }, ok: true }]);
    expect(summary).toContain(`03_auction_edges [lockstep/solana] PASS-WITH-DIVERGENCES 66/78, diverged at #65 as recorded (${TEST_ID})`);
    // a parting at the recorded step on other values fails; a recorded parting that does not happen is stale
    const otherValue = await replayLockstep(v, 'solana', { synthetic: ZERO_CHARGE, lockstep: { ...TEST_03_LOCKSTEP, diffs: TEST_03_LOCKSTEP.diffs.map((d) => (d.path === 'S1.feeCollector' ? { ...d, ours: '327800001' } : d)) } });
    expect(otherValue.status).toBe('FAIL');
    expect(otherValue.issues.map((i) => [i.index, i.kind, i.message])).toEqual([[65, 'fail', `the backends disagree after this step (3 field(s)); not as recorded for ${TEST_ID} (S1.auction.escrowTotal, S1.auctionEscrow, S1.feeCollector)`]]);
    const elsewhere = await replayLockstep(v, 'solana', { synthetic: ZERO_CHARGE, lockstep: { ...TEST_03_LOCKSTEP, divergesAt: 64 } });
    expect(elsewhere.status).toBe('FAIL');
    expect(elsewhere.issues.map((i) => [i.index, i.kind])).toEqual([[65, 'fail'], [64, 'fail']]);
    expect(elsewhere.issues[1]!.message).toBe(`stale divergence ${TEST_ID}: the backends were recorded to part after #64 and did not; remove the entry`);
    // the real 03 (the vector's own 1% on both sides) does not part at all: the recorded parting is stale
    const vanished = await replayLockstep(v, 'solana', { lockstep: TEST_03_LOCKSTEP });
    expect(vanished.executed).toBe(vanished.total);
    expect(vanished.issues.map((i) => [i.index, i.kind, i.message])).toEqual([[65, 'fail', `stale divergence ${TEST_ID}: the backends were recorded to part after #65 and did not; remove the entry`]]);
    expect(atExpected(vanished, expected)).toBe(false);
  }, 120_000);

  // cause NRC (was: PASS-WITH-DIVERGENCES on the five DIV-NRC-1 fields): 03 replays in full on the merces backend; the
  // replay side of the divergence mechanism is checked on the test-only divergence
  it('03 is PASS in full on the merces backend; a recorded divergence is accepted as recorded, a moved value fails, a vanished one is stale', async () => {
    const r = await runStage1Vectors({ dir: VECTORS, backend: 'merces', only: ['03'] });
    for (const run of r.runs) expect([run.status, run.executed, run.total, run.issues, run.atExpected], run.world).toEqual(['PASS', 78, 78, [], true]);
    const replay = async (vector: LoadedVector, personality: 'solana' | 'monad', synthetic?: SyntheticShims) => {
      const world = await MercesWorld.create(vector, { personality, ...(synthetic ? { synthetic } : {}) });
      try {
        return await replayVector(world, vector, { divergences: TEST_03 });
      } finally {
        await world.close();
      }
    };
    const v = loadVector(vectorFile('03'));
    for (const personality of ['solana', 'monad'] as const) {
      const run = await replay(v, personality, ZERO_CHARGE);
      expect(run.status, personality).toBe('PASS-WITH-DIVERGENCES');
      expect(run.executed).toBe(run.total);
      expect(run.issues.map((i) => [i.index, i.kind, i.divergence, i.diffs?.map((d) => d.path)])).toEqual([
        [67, 'divergence', TEST_ID, ['auction.escrowTotal', 'auctionEscrow', 'feeCollector']],
        [77, 'divergence', TEST_ID, ['balances.b8.stable', 'feeCollector']],
      ]);
    }
    // the vector's value at a recorded path changes (as if Stage 1 charged 1 USDC more): that field fails, the rest stay accepted
    const src = raw('03_auction_edges');
    src.steps[67]!.feeCollector = '428800001';
    const moved = await replay(fromJson(src, '03_auction_edges'), 'solana', ZERO_CHARGE);
    expect(moved.status).toBe('FAIL');
    expect(moved.issues.map((i) => [i.index, i.kind, i.message])).toEqual([
      [67, 'fail', '1 expected value(s) differ (1 at a recorded divergence path with another value: feeCollector)'],
      [67, 'divergence', `known divergence ${TEST_ID}: 2 field(s) differ as recorded (accepted, not parity)`],
      [77, 'divergence', `known divergence ${TEST_ID}: 2 field(s) differ as recorded (accepted, not parity)`],
    ]);
    // the behaviour fixed, in effect (the real 03, the vector's own 1% on both sides): every recorded entry is stale
    const stale = await replay(v, 'monad');
    expect(stale.status).toBe('FAIL');
    expect(stale.issues.map((i) => [i.index, i.kind, i.message])).toEqual([
      [67, 'fail', `stale divergence ${TEST_ID}: auction.escrowTotal no longer differs (recorded: Stage 1 "55925700000", ours "56026700000"); remove the entry`],
      [67, 'fail', `stale divergence ${TEST_ID}: auctionEscrow no longer differs (recorded: Stage 1 "55925700000", ours "56026700000"); remove the entry`],
      [67, 'fail', `stale divergence ${TEST_ID}: feeCollector no longer differs (recorded: Stage 1 "428800000", ours "327800000"); remove the entry`],
      [77, 'fail', `stale divergence ${TEST_ID}: balances.b8.stable no longer differs (recorded: Stage 1 "29899000000", ours "30000000000"); remove the entry`],
      [77, 'fail', `stale divergence ${TEST_ID}: feeCollector no longer differs (recorded: Stage 1 "428800000", ours "327800000"); remove the entry`],
    ]);
  }, 120_000);

  // the test-only divergence's "ours" values are Stage 1's own arithmetic with the charge at 0 bps, not figures of our
  // engine alone (the former DIV-NRC-1 check)
  it("the test-only divergence's values are Stage 1's: its own simulator with 03's charge rate at 0 bps differs from the vector on exactly the five entries", async () => {
    const src = raw('03_auction_edges');
    const create = src.steps[15] as { op: string; series: string; terms: Record<string, string> };
    expect([create.op, create.series, create.terms.nonRevealChargeBps]).toEqual(['create_series', 'S1', '100']);
    create.terms.nonRevealChargeBps = '0';
    const run = (await runStage1Vectors({ vectors: [fromJson(src, '03_auction_edges')], backend: 'reference' })).runs[0]!;
    expect(run.executed).toBe(run.total);
    const diffs = run.issues.flatMap((i) => (i.diffs ?? []).map((d) => ({ id: TEST_ID, step: i.index, path: d.path, stage1: d.expected, ours: d.actual })));
    expect(run.issues.every((i) => i.kind === 'fail' && i.diffs)).toBe(true);
    expect(diffs).toEqual(TEST_03);
  }, 60_000);

  it('prefix gates: a gated vector replays to its gate and is PREFIX-PASS; past the gate it is judged on the prefix; a finding before the gate fails', async () => {
    const r = await runStage1Vectors({ dir: VECTORS, backend: 'merces', only: ['08'], personalities: ['solana'] });
    const run = r.runs[0]!;
    expect([run.status, run.executed, run.stopped, run.issues, run.atExpected]).toEqual(['PASS', 34, { index: 34, reason: 'until' }, [], true]);
    expect(run.expected.status).toBe('PREFIX-PASS');
    // the caller's own last step replaces the gate: 08 then stops on the op it waits for (#34, S5), which lies past the gate
    const past = (await runStage1Vectors({ dir: VECTORS, backend: 'merces', only: ['08'], personalities: ['solana'], until: 40 })).runs[0]!;
    expect(past.status).toBe('FAIL');
    expect(past.issues[0]).toMatchObject({ index: 34, op: 'withdraw_pause_request', kind: 'blocked' });
    expect(past.atExpected).toBe(true);
    // a finding at or before the gate is not at expected status: 08#32 expects approve_pause to revert PauseNotRequested
    const src = raw('08_hardship_pause');
    expect(src.steps[32]).toMatchObject({ op: 'expect_revert', call: { op: 'approve_pause' }, error: 'PauseNotRequested' });
    src.steps[32]!.error = 'PauseTooLong';
    const broken = (await runStage1Vectors({ vectors: [fromJson(src, '08_hardship_pause')], backend: 'merces', personalities: ['solana'] })).runs[0]!;
    expect([broken.status, broken.stopped, broken.atExpected]).toEqual(['FAIL', { index: 34, reason: 'until' }, false]);
    expect(broken.issues.map((x) => [x.index, x.message])).toEqual([[32, 'expected revert PauseTooLong for approve_pause, got PauseNotRequested']]);
  }, 120_000);

  // the optional gate of S2 plan WP5: vector 18 stops at #11 on the merces backend (create_series with a router, S5);
  // a copy without the router (tier 2 only, #31 route_income replaced by a zero fund) checks Stage 1's state while a
  // raise is part processed (#29), and MintNotFinalized on claim_release (#30), submit_report (#33), pay (#34) and
  // redeem (#36), in lockstep up to #40 on both personalities
  it('lockstep: a router-stripped copy of 18 agrees up to #40, mid-processing included (#35 retire_if_capped is BLK-1)', async () => {
    const src = raw('18_report_before_finalization');
    expect(src.steps[11]).toMatchObject({ op: 'create_series', tierFlags: 3 });
    expect(src.steps[31]).toMatchObject({ op: 'route_income' });
    Object.assign(src.steps[11]!, { tierFlags: 2, router: null });
    src.steps[31] = { t: src.steps[31]!.t, op: 'fund', actor: 'issuer', amount: '0' };
    const v = fromJson(src, '18_report_before_finalization');
    const r = await runStage1Vectors({ vectors: [v], backend: 'lockstep', until: 40 });
    for (const run of r.runs) {
      expect(run.executed, run.world).toBe(41);
      expect(run.issues, run.world).toEqual([{ index: 35, op: 'expect_revert retire_if_capped', kind: 'blocked', message: 'the merces backend does not run this call (retire_if_capped has no canonical command)', shimId: 'BLK-1' }]);
    }
  }, 120_000);

  it('lockstep counts the shims of passing reverts (11: amend_terms at #45 and redeem at #43 run only inside expect_revert)', async () => {
    const r = (await runStage1Vectors({ dir: VECTORS, backend: 'lockstep', only: ['11'], personalities: ['solana'] })).runs[0]!;
    expect(r.issues).toEqual([]);
    expect(r.status).toBe('PASS');
    expect(r.shims['SH-AMD-1']).toBe(1);
    expect(r.shims['SH-RED-1']).toBe(1);
    expect(r.runnerAtomic).toEqual([]);
  }, 60_000);

  it('lockstep stops at the first step after which the backends disagree', async () => {
    const src = raw('01_happy_path');
    // an op the merces backend does not run yet, after the settled expect: the states part there
    src.steps.splice(32, 0, { t: src.steps[31]!.t, op: 'set_release_pause', actor: 'issuer', series: 'S1', paused: false });
    const r = (await runStage1Vectors({ vectors: [fromJson(src, '01_happy_path')], backend: 'lockstep', personalities: ['solana'] })).runs[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.stopped).toEqual({ index: 33, reason: 'diverged' });
    expect(r.issues.map((i) => [i.index, i.kind, i.message])).toEqual([
      // cause S2-NY: was "set_release_pause is not in S1 (S5)"
      [32, 'blocked', 'the merces backend does not run this call (set_release_pause is not modelled yet (S5))'],
      [32, 'fail', 'the merces backend did not run this action, so the states part here'],
    ]);
  }, 60_000);

  // cause S2-VR: validity is fixed at reveal on both backends (was: the one-step settlement clamped the over-cap bid to
  // the cap and filled it, so the retired SH-AUC-3 shim found the models disagree and failed the step)
  it('an over-cap bid is invalid on both backends: the settlements agree, and lockstep agrees through the raise', async () => {
    // b1 bids 150 units, above the 100-unit wallet cap: Stage 1 records the bid as invalid and refunds it in full
    const src = raw('01_happy_path');
    for (const s of src.steps) {
      if ((s.op === 'commit_bid' || s.op === 'reveal_bid') && s.actor === 'b1') {
        s.quantity = '150';
        if (s.op === 'commit_bid') s.escrow = String(120_000_000n * 150n + (120_000_000n * 150n) / 100n);
      }
      if (s.op === 'begin_settlement') s.qAboveClaim = '200';
    }
    const v = fromJson(src, '01_happy_path');
    // cause S2-MS: the raise settles at finalize_settlement (begin_settlement only proposes)
    const i = v.steps.findIndex((s) => s.op === 'finalize_settlement');
    const world = await MercesWorld.create(v, { personality: 'monad' });
    for (const step of v.steps.slice(0, i + 1)) {
      world.setTime(BigInt(step.t));
      if (step.op !== 'expect') await world.apply(step as unknown as Parameters<typeof world.apply>[0]);
    }
    const series = [...world.chain.state.series.values()][0]!;
    const b1 = series.bids.get(world.actors.address('b1'))!;
    expect([b1.valid, b1.revealed?.quantity]).toEqual([false, 150n]);
    expect([series.phase, series.unitsSold, series.issuePrice, series.auction.validCount]).toEqual(['Settled', 300n, 105_000_000n, 3]);
    const lock = (await runStage1Vectors({ vectors: [v], backend: 'lockstep', until: raisePrefixEnd(v), personalities: ['monad'] })).runs[0]!;
    expect(lock.issues).toEqual([]);
  }, 60_000);

  // cause S2-MS: a proposal Stage 1 rejects is recorded and the next round runs (was: BLOCKED, the one-step settlement
  // could not represent a rejected round)
  it('a proposal Stage 1 would reject is recorded (ClaimMismatch) and the next round settles, on the runner and in lockstep', async () => {
    const src = raw('01_happy_path');
    const i = src.steps.findIndex((s) => s.op === 'begin_settlement');
    const honest = structuredClone(src.steps[i]!);
    expect(src.steps[i + 1]).toMatchObject({ op: 'finalize_settlement' });
    src.steps[i]!.qAtClaim = '99';
    // the rejected round, then the honest proposal and its finalize at the same instant
    src.steps.splice(i + 2, 0, honest, { t: honest.t, op: 'finalize_settlement', series: 'S1' });
    const v = fromJson(src, '01_happy_path');
    const world = await MercesWorld.create(v, { personality: 'solana' });
    const auction = () => [...world.chain.state.series.values()][0]!.auction;
    for (const [k, step] of v.steps.slice(0, i + 4).entries()) {
      world.setTime(BigInt(step.t));
      if (step.op !== 'expect') await world.apply(step as unknown as Parameters<typeof world.apply>[0]);
      if (k === i + 1) expect([auction().tallyRound, auction().roundRejected, auction().rejectionReason, [...world.chain.state.series.values()][0]!.phase]).toEqual([1, true, 'ClaimMismatch', 'Settling']);
    }
    expect([auction().tallyRound, auction().roundRejected, auction().rejectionReason, auction().unitsSold, auction().clearingPrice]).toEqual([2, false, null, 400n, 105_000_000n]);
    await world.close();
    const lock = (await runStage1Vectors({ vectors: [v], backend: 'lockstep', until: raisePrefixEnd(v), personalities: ['solana'] })).runs[0]!;
    expect(lock.issues).toEqual([]);
  }, 60_000);

  // review finding "Waivers match any shim-less BLOCKED op at a waived step index": 01#34 turned into an op outside S1
  // (no shim row) was waived by BLK-1, so the vector came out PASS-WITH-WAIVERS (ok) on both the runner and lockstep
  it('a waived index holding another op is BLOCKED on the runner and in lockstep', async () => {
    const src = raw('01_happy_path');
    expect(src.steps[34]).toMatchObject({ op: 'expect_revert', call: { op: 'retire_if_capped' } });
    const endPause = structuredClone(src);
    endPause.steps[34] = { t: src.steps[34]!.t, op: 'expect_revert', call: { op: 'end_pause', actor: 'issuer', series: 'S1' }, error: 'NotPaused' };
    // the same op as an action, not the revert check the waiver names
    const asAction = structuredClone(src);
    asAction.steps[34] = { t: src.steps[34]!.t, op: 'retire_if_capped', series: 'S1' };
    for (const [mutated, op] of [[endPause, 'expect_revert end_pause'], [asAction, 'retire_if_capped']] as const) {
      const v = fromJson(mutated, '01_happy_path');
      const r = await runStage1Vectors({ vectors: [v], backend: 'merces', personalities: ['solana'], until: 36 });
      const run = r.runs[0]!;
      expect(run.status, op).toBe('BLOCKED');
      expect(run.issues.find((i) => i.index === 34), op).toMatchObject({ op, kind: 'blocked' });
      expect(run.issues.find((i) => i.index === 34)!.waived, op).toBeUndefined();
      expect(run.issues.find((i) => i.index === 32)?.waived, op).toBe(true);
      expect(run.atExpected, op).toBe(false);
      expect(r.ok, op).toBe(false);
    }
    const lock = (await runStage1Vectors({ vectors: [fromJson(endPause, '01_happy_path')], backend: 'lockstep', personalities: ['solana'], until: 36 })).runs[0]!;
    expect(lock.status).toBe('BLOCKED');
    // cause S2-NY: was "end_pause is not in S1 (S5)"
    expect(lock.issues.find((i) => i.index === 34)).toEqual({ index: 34, op: 'expect_revert end_pause', kind: 'blocked', message: 'the merces backend does not run this call (end_pause is not modelled yet (S5))' });
    expect(lock.atExpected).toBe(false);
  }, 120_000);

  // disputed review finding "The 'revert leaves state unchanged' check cannot fail on the merces backend": the world
  // restored every op that threw before the check compared, so an engine whose reverted transactions leaked a change
  // still passed vector 04
  it('a reverted transaction that changes the engine fails its revert check, although the world restores the state', async () => {
    const v = loadVector(join(VECTORS, '04_zero_quarters.json'));
    const world = await MercesWorld.create(v, { personality: 'solana' });
    const engine = world.chain.engine;
    const execute = engine.execute.bind(engine);
    let leaks = 0;
    engine.execute = ((...a: Parameters<typeof execute>) => {
      try {
        return execute(...a);
      } catch (e) {
        engine.state.txCount += 1000; // after the engine restored its own backup
        leaks++;
        throw e;
      }
    }) as typeof engine.execute;
    try {
      const run = await replayVector(world, v);
      const reverts = v.steps.flatMap((s, i) => (s.op === 'expect_revert' ? [[i, `${s.call.op} reverted with ${s.error} but changed the state`]] : []));
      expect(reverts).toHaveLength(6);
      expect(leaks).toBe(6);
      expect(run.status).toBe('FAIL');
      expect(run.issues.map((i) => [i.index, i.message])).toEqual(reverts);
      // each leak was undone by the world, so the replay went on to the end
      expect(run.executed).toBe(run.total);
    } finally {
      await world.close();
    }
  }, 120_000);

  // cause S3-SH: no row of the shim table is runner-atomic since SH-CLM-2 became the direct claimTail, so the mechanism
  // is exercised on a synthetic row that sends two transactions for one call (was: SH-CLM-2 at 09#82)
  it('a multi-transaction shim that reverts in its second transaction is runner-atomic; its row must say so (synthetic row)', async () => {
    expect(SHIMS.filter((s) => s.runnerAtomic)).toEqual([]);
    // 09#82: b4 never claimed its redemption, so the synthetic row sends claimRedemption, then claimTail
    const src = raw('09_tail_clause');
    expect(src.steps[82]).toMatchObject({ op: 'claim_tail', actor: 'b4', series: 'S1' });
    const t = src.steps[82]!.t as string;
    const reverting = structuredClone(src);
    reverting.steps[82] = { t, op: 'expect_revert', call: { op: 'claim_tail', actor: 'b4', series: 'S1' }, error: 'NoTailDue' };
    const atomicRow: Shim = { id: 'SH-TEST-1', ops: ['claim_tail'], call: 'claimRedemption first when nothing is redeemed yet, then claimTail', why: 'test only', removedIn: '—', kind: 'shim', runnerAtomic: true };
    const synthetic = (row: Shim): SyntheticShims => ({
      rows: [row],
      translators: {
        claim_tail: (ctx, c) => ({
          kind: 'shim',
          shimId: row.id,
          run: async () => {
            const seriesId = ctx.seriesBook(c.series).seriesId;
            const wallet = ctx.actors.wallet(c.actor);
            const p = ctx.seriesState(c.series).positions.get(wallet.address);
            if (p && p.redeemedUnits === 0n && p.units > 0n) await ctx.send(wallet, { kind: 'claimRedemption', seriesId });
            await ctx.send(wallet, { kind: 'claimTail', seriesId });
          },
        }),
      },
    });
    /** b4's claimTail at #82 raises NoTailDue, after changing the engine when `leak` */
    const refuseTail = (world: MercesWorld, leak: boolean) => {
      const engine = world.chain.engine;
      const execute = engine.execute.bind(engine);
      const b4 = world.actors.address('b4');
      engine.execute = ((cmd, actor, ctx) => {
        if (cmd.kind === 'claimTail' && (actor as { signers?: string[] }).signers?.[0] === b4 && world.now() === Number(t)) {
          if (leak) engine.state.txCount += 1000;
          throw new ChainError('NotPermitted', 'claimTail refused by the test', { stage1: 'NoTailDue' });
        }
        return execute(cmd, actor, ctx);
      }) as typeof engine.execute;
    };
    const replay = async (vector: LoadedVector, row: Shim, leak?: boolean) => {
      const world = await MercesWorld.create(vector, { personality: 'solana', synthetic: synthetic(row) });
      if (leak !== undefined) refuseTail(world, leak);
      try {
        return await replayVector(world, vector, { until: 82 });
      } finally {
        await world.close();
      }
    };
    const v = fromJson(reverting, '09_tail_clause');
    // claimRedemption went through, claimTail reverted cleanly: the runner undid the first, and says so
    const run = await replay(v, atomicRow, false);
    expect(run.issues).toEqual([]);
    expect(run.status).toBe('PASS');
    expect(run.runnerAtomic).toEqual([{ index: 82, op: 'expect_revert claim_tail', shimId: 'SH-TEST-1', rolledBack: 1 }]);
    expect(run.shims['SH-TEST-1']).toBe(1);
    const md = renderParity([{ backend: 'merces', runs: [{ ...run, expected: EXPECTED['09']!, atExpected: true }], notRun: [], proofs: { verified: 0, invalid: 0, cacheHits: 0 }, ok: true }], { dir: 'x' });
    expect(md).toContain('- 09_tail_clause #82 `expect_revert claim_tail` (SH-TEST-1) on merces/solana: 1 transaction undone by the runner');
    // a synthetic row is the test's own: the shim table does not list it
    expect(md).not.toContain('| SH-TEST-1');
    // the second transaction's own revert is checked against the state just before it, not the op's start
    const leaked = await replay(v, atomicRow, true);
    expect(leaked.issues).toEqual([{ index: 82, op: 'expect_revert claim_tail', kind: 'fail', message: 'claim_tail reverted with NoTailDue but changed the state' }]);
    // a shim row not marked runner-atomic may not send two transactions for one call
    const { runnerAtomic: _marked, ...unmarkedRow } = atomicRow;
    const unmarked = await replay(fromJson(src, '09_tail_clause'), unmarkedRow);
    expect(unmarked.status).toBe('FAIL');
    expect(unmarked.issues).toEqual([{ index: 82, op: 'claim_tail', kind: 'fail', message: 'claim_tail went through 2 transactions, but shim row SH-TEST-1 is not marked runner-atomic' }]);
    // the table's own claim_tail is one transaction (direct): the same step passes with the claimTail refused cleanly
    const world = await MercesWorld.create(v, { personality: 'solana' });
    refuseTail(world, false);
    try {
      const direct = await replayVector(world, v, { until: 82 });
      expect([direct.status, direct.runnerAtomic, direct.shims['SH-TEST-1']]).toEqual(['PASS', [], undefined]);
    } finally {
      await world.close();
    }
  }, 120_000);

  // Stage 1's create_series rules (SIM:756-781) on both backends: every refusal raises Stage 1's error and leaves the
  // state untouched, and terms at the bounds themselves are accepted (review finding "createSeries skips Stage 1's
  // create_series parameter bounds"; before the fix the merces backend accepted every one of these series)
  it('create_series: out-of-bounds parameters, unreachable terms and bad release schedules revert as in Stage 1', async () => {
    const src = raw('04_zero_quarters');
    const created = src.steps.findIndex((s) => s.op === 'create_series');
    const base = src.steps[created]! as Record<string, unknown> & { terms: Record<string, string>; releaseSchedule: { atOffsetSeconds: string; bps: string }[] };
    const WAD = 10n ** 18n;
    const YEAR = 365n * 86_400n;
    const tranches = (n: number) => Array.from({ length: n }, (_, i) => ({ atOffsetSeconds: String(i * 86_400), bps: String(i < n - 1 ? Math.floor(10_000 / n) : 10_000 - (n - 1) * Math.floor(10_000 / n)) }));
    const call = (series: string, terms: Record<string, string>, releaseSchedule = base.releaseSchedule) => ({ ...structuredClone(base), series, terms: { ...base.terms, ...terms }, releaseSchedule });
    const reverts: [Record<string, unknown>, string][] = [
      [call('X1', { capMultipleWad: String(3n * WAD + 1n) }), 'ParameterOutOfBounds'],
      [call('X2', { hurdleRateWad: String(WAD / 4n + 1n) }), 'ParameterOutOfBounds'],
      [call('X3', { payoutMultipleK: '21' }), 'ParameterOutOfBounds'],
      [call('X4', { lockupSeconds: String(5n * YEAR + 1n) }), 'ParameterOutOfBounds'],
      [call('X5', { walletCapBps: '99' }), 'ParameterOutOfBounds'],
      [call('X6', { auctionFeeBps: '1001' }), 'ParameterOutOfBounds'],
      [call('X7', { payoutFeeBps: '2001' }), 'ParameterOutOfBounds'],
      [call('X8', { minRaise: String(BigInt(base.terms.reservePrice!) * BigInt(base.terms.unitsOffered!) + 1n) }), 'InvalidTerms'],
      [call('X9', { unitsOffered: '5', minRaise: '0' }), 'InvalidTerms'], // floor(5 × 10%) = 0: a wallet cap below one unit
      [call('X10', {}, [{ atOffsetSeconds: '7776000', bps: '5000' }, { atOffsetSeconds: '0', bps: '5000' }]), 'InvalidReleaseSchedule'],
      [call('X11', {}, tranches(25)), 'InvalidReleaseSchedule'],
      [call('X12', {}, [{ atOffsetSeconds: '0', bps: '9000' }]), 'InvalidReleaseSchedule'],
      // Stage 1's order: the bounded parameters come before the release schedule
      [call('X13', { hurdleRateWad: String(WAD / 2n) }, [{ atOffsetSeconds: '7776000', bps: '5000' }, { atOffsetSeconds: '0', bps: '5000' }]), 'ParameterOutOfBounds'],
      // cause S2-CR: the raise's own terms are canonical since S2, so the engine bounds them too
      [call('X14', { nonRevealChargeBps: '1001' }), 'ParameterOutOfBounds'],
      [call('X15', { commitDuration: '3599' }), 'ParameterOutOfBounds'],
      [call('X16', { commitDuration: String(30 * 86_400 + 1) }), 'ParameterOutOfBounds'],
      [call('X17', { revealDuration: '3599' }), 'ParameterOutOfBounds'],
      [call('X18', { revealDuration: String(7 * 86_400 + 1) }), 'ParameterOutOfBounds'],
      [call('X19', { commitDuration: '3599', minRaise: String(BigInt(base.terms.reservePrice!) * BigInt(base.terms.unitsOffered!) + 1n) }), 'ParameterOutOfBounds'],
    ];
    const atBounds = call('S9', { capMultipleWad: String(2n * WAD), hurdleRateWad: String(WAD / 4n), payoutMultipleK: '20', lockupSeconds: String(5n * YEAR), walletCapBps: '100', auctionFeeBps: '1000', payoutFeeBps: '2000', nonRevealChargeBps: '1000', commitDuration: String(30 * 86_400), revealDuration: String(7 * 86_400) }, tranches(24));
    const atLowerBounds = call('S10', { nonRevealChargeBps: '0', commitDuration: '3600', revealDuration: '3600' });
    const t = base.t;
    src.steps = [...src.steps.slice(0, created + 1), ...reverts.map(([c, error]) => ({ t, op: 'expect_revert', call: c, error })), { t, ...atBounds }, { t, ...atLowerBounds }];
    const v = fromJson(src, '04_zero_quarters');
    for (const backend of ['reference', 'merces'] as const) {
      const r = await runStage1Vectors({ vectors: [v], backend, personalities: ['solana', 'monad'] });
      for (const run of r.runs) {
        expect(run.issues, `${backend} ${run.world}`).toEqual([]);
        expect(run.status, `${backend} ${run.world}`).toBe('PASS');
        expect(run.executed, `${backend} ${run.world}`).toBe(v.steps.length);
      }
    }
  }, 120_000);

  it('new raises paused: create_series still succeeds and open_raise reverts NewRaisesPaused, as in Stage 1 (SIM:875)', async () => {
    const src = raw('04_zero_quarters') as ReturnType<typeof raw> & { config: { flags: Record<string, boolean> } };
    src.config.flags.newRaisesPaused = true;
    const open = src.steps.findIndex((s) => s.op === 'open_raise');
    const { t, ...openCall } = src.steps[open]!;
    src.steps = [...src.steps.slice(0, open), { t, op: 'expect_revert', call: openCall, error: 'NewRaisesPaused' }];
    const v = fromJson(src, '04_zero_quarters');
    expect(v.steps.filter((s) => s.op === 'create_series').length).toBeGreaterThan(0);
    for (const backend of ['reference', 'merces'] as const) {
      const r = await runStage1Vectors({ vectors: [v], backend, personalities: ['solana', 'monad'] });
      for (const run of r.runs) {
        expect(run.issues, `${backend} ${run.world}`).toEqual([]);
        expect(run.status, `${backend} ${run.world}`).toBe('PASS');
      }
    }
  }, 60_000);

  it('every op the vectors use has a translator; the ops not modelled yet name the same milestones as the op map', () => {
    for (const f of listVectorFiles(VECTORS)) {
      for (const s of loadVector(f).steps) {
        const op = s.op === 'expect_revert' ? s.call.op : s.op;
        if (op !== 'expect') expect(TRANSLATORS[op as keyof typeof TRANSLATORS], op).toBeDefined();
      }
    }
    // cause S2-NY: NOT_YET and the op kind `not-yet` (were NOT_IN_S1 and `not-in-s1`)
    const notYet = Object.fromEntries(Object.entries(STAGE1_OP_MAP).filter(([, m]) => m.kind === 'not-yet').map(([op, m]) => [op, m.milestone]));
    expect(NOT_YET).toEqual(notYet);
    // cause S2-RH, S2-MS: the raise's ops run directly since S2, `commit_bid` aside (our commitment until S4)
    expect(NOT_YET).not.toHaveProperty('cancel_raise');
    expect(NOT_YET).not.toHaveProperty('register_holder');
    for (const op of ['open_raise', 'cancel_raise', 'reveal_bid', 'begin_settlement', 'finalize_settlement', 'process_bid', 'deliver_bid', 'register_holder']) expect(STAGE1_OP_MAP[op]?.kind, op).toBe('direct');
    expect(STAGE1_OP_MAP.commit_bid).toMatchObject({ kind: 'shim', shim: 'SH-AUC-2' });
    // cause S3-SH: the whole claim family runs directly: the tail, final and Retired-burn claims since WP2 (was: SH-CLM-2,
    // SH-CLM-3, SH-BRN-1) and `claim` since WP3, when claimPayout became Stage 1's claim (was: SH-CLM-1)
    for (const op of ['claim', 'claim_tail', 'claim_final', 'burn_retired']) {
      expect(STAGE1_OP_MAP[op], op).toMatchObject({ kind: 'direct' });
      expect(STAGE1_OP_MAP[op], op).not.toHaveProperty('shim');
      expect(SHIMS.some((r) => r.ops.includes(op)), op).toBe(false);
    }
    expect(STAGE1_OP_MAP.claim).toEqual({ canonical: 'claimPayout', kind: 'direct' });
  });

  it('vector keys become stable ed25519 verifier keys whose attestations verify', async () => {
    const { VectorKeyring } = await import('../src/stage1-vectors/keys.ts');
    const { attestationMessage } = await import('@merces/domain');
    const { createPublicKey, verify } = await import('node:crypto');
    const v = loadVector(join(VECTORS, '04_zero_quarters.json'));
    const a = new VectorKeyring(v.keys).ed25519('verifier1');
    const b = new VectorKeyring(v.keys).ed25519('verifier1');
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(new VectorKeyring(v.keys).ed25519('attestor1').publicKeyHex).not.toBe(a.publicKeyHex);
    const fields = { seriesId: 'monad:0x' + '11'.repeat(20), periodId: '2026Q1', priorIncomeCommitment: '0x' + '00'.repeat(32), incomeCommitment: '0x' + '01'.repeat(32), tier: 2 as const, liquidityEvent: false };
    const att = a.attest(fields);
    expect(att.keyId).toBe('verifier1');
    const pub = createPublicKey({ key: Buffer.from(a.publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(attestationMessage(fields)), pub, Buffer.from(att.signature.slice(2), 'hex'))).toBe(true);
  });

  // the S2 gate (S2 plan WP5): one default run (every target in full, every prefix gate to its gate) on both
  // personalities, shared by the next two tests
  let full: RunReport | undefined;
  const fullRun = async (): Promise<RunReport> => (full ??= await runStage1Vectors({ dir: VECTORS, backend: 'merces' }));

  // cause S2-NY: 42 runs, the 14 targets and the 7 prefix gates on both personalities (was: the 10 S1 targets, 20 runs).
  // Cause NRC: 38/42 PASS, 03 among them (was 36/42, 03 PASS-WITH-DIVERGENCES on its five DIV-NRC-1 fields)
  it('every target and prefix gate is at its expected status on both personalities: 38/42 PASS, 03 in full', async () => {
    const report = await fullRun();
    const ids = [...TARGETS, ...Object.keys(PREFIX_GATES)].sort();
    expect(report.runs.map((r) => `${r.id}/${r.world}`)).toEqual(ids.flatMap((id) => [`${id}/merces/solana`, `${id}/merces/monad`]));
    for (const r of report.runs) expect(r.atExpected, `${r.vector} ${r.world}: ${r.status}`).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.runs.filter((r) => r.status === 'PASS')).toHaveLength(38);
    const statusOf = (id: string) => [...new Set(report.runs.filter((r) => r.id === id).map((r) => r.status))];
    for (const id of ['02', '03', '15', '17']) expect(statusOf(id), id).toEqual(['PASS']);
    for (const id of ['01', '05']) expect(statusOf(id), id).toEqual(['PASS-WITH-WAIVERS']);
    for (const r of report.runs) expect(r.issues.filter((i) => i.kind === 'divergence'), `${r.vector} ${r.world}`).toEqual([]);
    for (const r of report.runs.filter((x) => x.id === '03')) expect([r.executed, r.total, r.issues], r.world).toEqual([78, 78, []]);
    for (const [id, until] of Object.entries(PREFIX_GATES)) {
      for (const r of report.runs.filter((x) => x.id === id)) expect([r.status, r.executed, r.stopped], `${id} ${r.world}`).toEqual(['PASS', until + 1, { index: until + 1, reason: 'until' }]);
    }
    // cause S2-NY: only the vectors that never reach the auction, or stop before it, are left out (was: 15 vectors)
    expect(report.notRun.map((n) => [n.id, n.expected.status])).toEqual([['12', 'NOT-YET'], ['13', 'NOT-YET'], ['18', 'NOT-YET'], ['24', 'NOT-YET']]);
    // the report proofs went through the ports' Groth16 verifier: 04#66 passes only because its pairing check fails
    // (its signals match the claimed payment), so a verifier that accepted everything would leave 04 off its status
    expect(report.proofs.verified).toBeGreaterThan(0);
  }, 180_000);

  it('the shim table is written into VECTOR_PARITY.md under "Shims (not parity)", with the known divergences and the prefix gates, and a merces run carries public values only', async () => {
    const report = await fullRun();
    expect(report.runs).toHaveLength((TARGETS.length + Object.keys(PREFIX_GATES).length) * 2);
    expect(report.notRun).toHaveLength(4);
    const md = renderParity([report], { dir: '$STAGE1_PATH/packages/vectors' });
    const section = md.slice(md.indexOf('## Shims (not parity)'));
    expect(section.length).toBeGreaterThan(0);
    for (const s of SHIM_BY_ID.values()) expect(section, s.id).toContain(`| ${s.id}`);
    // cause S2-MS: the commitment is the raise's only shim left (SH-AUC-3..6 retired); it goes in S4. "Used in" is
    // every vector of the report that commits a bid (computed from the runs, not pinned by hand)
    const committing = [...new Set(report.runs.filter((r) => r.shims['SH-AUC-2']).map((r) => r.id))].sort();
    expect(committing).toEqual([...TARGETS, ...Object.keys(PREFIX_GATES)].sort());
    expect(section).toContain(`| SH-AUC-2 | \`commit_bid\` |`);
    expect(section).toMatch(new RegExp(`\\| SH-AUC-2 \\| \`commit_bid\` \\|[^\\n]*\\| S4 \\| ${committing.join(', ')} \\|`));
    expect(section).not.toMatch(/SH-AUC-[3-6]/);
    expect(section).toMatch(/\| BLK-1 \(BLOCKED\) \| `retire_if_capped` \|/);
    // cause NRC: the known divergences section says the register is empty (was: the DIV-NRC-1 row, its five entries, its
    // lockstep parting and where the runs met it), and 03's row is PASS in full
    const known = md.slice(md.indexOf('## Known divergences (not parity)'), md.indexOf('## Prefix gates'));
    expect(known).toContain('None: the register is empty. Its only row, DIV-NRC-1 (the non-reveal charge, held in S2), went when the charge was modelled');
    expect(known).not.toContain('### ');
    expect(md).not.toContain('PASS-WITH-DIVERGENCES (');
    expect(md).toContain('| 03_auction_edges | PASS 78/78 | PASS 78/78 | PASS |');
    expect(md.slice(md.indexOf('## Findings'), md.indexOf('## Known divergences'))).toContain('None: every replayed step matched.');
    const gates = md.slice(md.indexOf('## Prefix gates'), md.indexOf('## Waived steps'));
    for (const [id, until] of Object.entries(PREFIX_GATES)) expect(gates).toMatch(new RegExp(`\\| ${id}_[a-z0-9_]+ \\| #${until} \\| #${until + 1} `));
    expect(md).toContain('| 08_hardship_pause | PASS 34/64, stopped at #34 (until) | PASS 34/64, stopped at #34 (until) | PREFIX-PASS to #33, then NOT-YET (S5: withdraw_pause_request and end_pause) |');
    expect(md).toContain('## Not replayed on the merces backend\n\n- 12_multi_series_router: NOT-YET (S5: income router)');
    // review finding "VECTOR_PARITY.md 'Used in' leaves out shims exercised by expect_revert steps": the calls of
    // passing reverts went through their shims too (amend_terms at 05#44 and 11#45, redeem at 01#33, 05#43, 11#43)
    for (const id of ['05', '11']) for (const r of report.runs.filter((x) => x.id === id)) expect(r.shims['SH-AMD-1'], `${id} ${r.world}`).toBe(1);
    for (const r of report.runs.filter((x) => x.id === '01')) expect(r.shims['SH-RED-1'], r.world).toBe(1);
    // cause S2-NY: 14's prefix amends its terms too (was: 05, 11)
    expect(section).toMatch(/\| SH-AMD-1 \| `amend_terms` \|[^\n]*\| S4 \| 05, 11, 14 \|/);
    expect(section).toMatch(/\| SH-RED-1 \| `redeem` \|[^\n]*\| — \| 01, 05, 06, 09, 11, 23, 25 \|/);
    // cause S3-SH: the claim family runs directly; its rows (SH-CLM-1, SH-CLM-2, SH-CLM-3, SH-BRN-1) are gone and no run
    // went through them (was: SH-CLM-1 used in 01, 04, 05, 07, 17, 19 and 21 until WP3; SH-CLM-2 runner-atomic, used in
    // 09 and 23; SH-CLM-3 in 11; SH-BRN-1 in 05)
    for (const id of ['SH-CLM-1', 'SH-CLM-2', 'SH-CLM-3', 'SH-BRN-1']) {
      expect(md, id).not.toContain(id);
      for (const r of report.runs) expect(r.shims[id], `${r.vector} ${r.world}`).toBeUndefined();
    }
    expect(section).not.toContain('(runner-atomic)');
    expect(md).toContain('## Runner-atomic reverts\n\nExpected reverts of a call');
    expect(md).toContain("None: every expected revert raised in the call's first transaction.");
    // privacy canary: no vector key, terms salt or income salt reaches the report
    const secrets = new Set<string>();
    for (const f of listVectorFiles(VECTORS)) {
      const v = JSON.parse(readFileSync(f, 'utf8')) as { keys: Record<string, { privateKey: string }>; seriesPrivate: Record<string, { termsPlain: { termsSalt: string } }>; steps: { op: string; call?: { witness?: Record<string, string> }; witness?: Record<string, string> }[] };
      for (const k of Object.values(v.keys)) secrets.add(k.privateKey.toLowerCase()).add(k.privateKey.slice(2).toLowerCase());
      for (const s of Object.values(v.seriesPrivate)) secrets.add(s.termsPlain.termsSalt);
      for (const s of v.steps) {
        const w = (s.op === 'expect_revert' ? s.call?.witness : s.witness) ?? {};
        for (const salt of [w.incomeSalt, w.priorSalt]) if (salt && salt !== '0') secrets.add(salt);
      }
    }
    const json = JSON.stringify(report).toLowerCase();
    for (const s of secrets) {
      expect(md.toLowerCase().includes(s)).toBe(false);
      expect(json.includes(s)).toBe(false);
    }
  }, 180_000);
});

describe('stage1:vectors CLI: merces backend', () => {
  it('pnpm stage1:vectors --only 01,04 --until 31 --personality solana,monad exits 0', () => {
    const stdout = execFileSync(join(ROOT, 'node_modules/.bin/tsx'), ['packages/stage1-sync/src/stage1-vectors/cli.ts', '--only', '01,04', '--until', '31', '--personality', 'solana,monad'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(stdout).toMatch(/01_happy_path \[merces\/solana\] PASS 32\/67, stopped at #32 \(until\)/);
    expect(stdout).toMatch(/04_zero_quarters \[merces\/monad\] PASS 32\/81, stopped at #32 \(until\)/);
    expect(stdout).toMatch(/OK: 4\/4 PASS, 4\/4 at expected status/);
  }, 120_000);
});

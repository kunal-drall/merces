import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainError } from '@merces/domain';
import type { Step } from '@merces/reference';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_S1,
  MercesWorld,
  NOT_IN_S1,
  ReferenceWorld,
  TRANSLATORS,
  SHIM_BY_ID,
  TARGETS_S1,
  atExpected,
  backendAvailable,
  checkRevert,
  compareExpect,
  fromJson,
  listVectorFiles,
  loadVector,
  opLabel,
  renderParity,
  replayVector,
  runStage1Vectors,
  shutdown,
  waiverFor,
  type LoadedVector,
  type RunReport,
  type World,
} from '../src/stage1-vectors/index.ts';
import { STAGE1_OP_MAP } from '../src/steps/vectors.ts';

const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const raw = (name: string) => JSON.parse(readFileSync(join(VECTORS, `${name}.json`), 'utf8')) as Record<string, unknown> & { steps: Record<string, unknown>[] };

/*
 * S2 cause codes:
 *  - S2-CR: Stage 1's creation rules over the raise's own terms (commit and reveal durations, the non-reveal charge),
 *    canonical since S2; `open_raise` runs directly (shim SH-AUC-1 retired);
 *  - S2-VR: a bid's validity is fixed at reveal (Stage 1 `isBidValid`): an over-cap bid is invalid and refunded in full;
 *  - S2-MS: Stage 1's multi-step settlement runs directly (begin, tally and finalize, process, deliver; shims
 *    SH-AUC-3..6 retired, the auction and holder views come from the engine);
 *  - S2-RH: `register_holder` runs directly (with `cancel_raise`, no longer outside the milestone).
 */
afterAll(shutdown);

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
    expect(atExpected(r, EXPECTED_S1['01']!)).toBe(false);
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

describe('stage1 vector runner: S1 expectations and the op map', () => {
  it('every target expects PASS (waivers only for blocked or n/a rows, each naming the op of its step); the others are NOT-IN-S1 with a milestone', () => {
    expect(Object.keys(EXPECTED_S1).sort()).toEqual(listVectorFiles(VECTORS).map((f) => f.split('/').at(-1)!.slice(0, 2)));
    for (const [id, e] of Object.entries(EXPECTED_S1)) {
      if ((TARGETS_S1 as readonly string[]).includes(id)) {
        expect(e.status, id).not.toBe('NOT-IN-S1');
        const v = loadVector(listVectorFiles(VECTORS).find((f) => f.split('/').at(-1)!.startsWith(`${id}_`))!);
        for (const w of e.waivers ?? []) {
          const row = SHIM_BY_ID.get(w.id);
          expect(['blocked', 'n/a'], `${id}#${w.step}`).toContain(row?.kind);
          // the step the waiver names is that op in the vector, and the row stands for that op
          expect(opLabel(v.steps[w.step]!), `${id}#${w.step}`).toBe(w.op);
          expect(row?.ops, `${id}#${w.step}`).toContain(w.op.replace(/^expect_revert /, ''));
        }
      } else expect(e.status === 'NOT-IN-S1' && !!e.milestone, id).toBe(true);
    }
  });

  // review finding "Waivers match any shim-less BLOCKED op at a waived step index": the id was compared only when the
  // op carried a shim row, so any op outside S1 (no row) landing on 01#32, 01#34 or 05#42 was waived
  it('a waiver covers only its own step, op and row', () => {
    const w = EXPECTED_S1['01']!.waivers!;
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
      if (m.kind === 'not-in-s1') expect(m.milestone, op).toBeTruthy();
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

/** The ops of the bootstrap and of the raise (Stage 1's settlement steps); a target's raise prefix ends before the first other op. */
const RAISE_PREFIX_OPS = new Set(['register_attestor', 'register_verifier_key', 'allowlist', 'register_issuer', 'fund', 'create_series', 'open_raise', 'commit_bid', 'reveal_bid', 'begin_settlement', 'finalize_settlement', 'process_bid', 'deliver_bid', 'expect']);
function raisePrefixEnd(v: LoadedVector): number {
  const i = v.steps.findIndex((s) => !RAISE_PREFIX_OPS.has(s.op));
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

  it('every S1 target replays its raise prefix (bootstrap, every raise, settled expects) without a finding on both personalities', async () => {
    for (const id of TARGETS_S1) {
      const v = loadVector(listVectorFiles(VECTORS).find((f) => f.split('/').at(-1)!.startsWith(`${id}_`))!);
      const until = raisePrefixEnd(v);
      expect(until, id).toBeGreaterThan(25);
      const r = await runStage1Vectors({ vectors: [v], backend: 'merces', until });
      expect(r.runs).toHaveLength(2);
      for (const run of r.runs) {
        expect(run.issues, `${run.vector} ${run.world}`).toEqual([]);
        expect(run.executed, `${run.vector} ${run.world}`).toBe(until + 1);
      }
    }
  }, 120_000);

  it('lockstep: the full snapshots of both backends agree after every raise prefix', async () => {
    const vectors = TARGETS_S1.map((id) => loadVector(listVectorFiles(VECTORS).find((f) => f.split('/').at(-1)!.startsWith(`${id}_`))!));
    for (const v of vectors) {
      const r = await runStage1Vectors({ vectors: [v], backend: 'lockstep', until: raisePrefixEnd(v), personalities: ['monad'] });
      expect(r.runs[0]!.world).toBe('lockstep/monad');
      expect(r.runs[0]!.issues, v.name).toEqual([]);
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
    // an op the merces backend does not run in S1, after the settled expect: the states part there
    src.steps.splice(32, 0, { t: src.steps[31]!.t, op: 'set_release_pause', actor: 'issuer', series: 'S1', paused: false });
    const r = (await runStage1Vectors({ vectors: [fromJson(src, '01_happy_path')], backend: 'lockstep', personalities: ['solana'] })).runs[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.stopped).toEqual({ index: 33, reason: 'diverged' });
    expect(r.issues.map((i) => [i.index, i.kind, i.message])).toEqual([
      [32, 'blocked', 'the merces backend does not run this call (set_release_pause is not in S1 (S5))'],
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
    expect(lock.issues.find((i) => i.index === 34)).toEqual({ index: 34, op: 'expect_revert end_pause', kind: 'blocked', message: 'the merces backend does not run this call (end_pause is not in S1 (S5))' });
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

  it('a multi-transaction shim that reverts in its second transaction is runner-atomic; its row must say so', async () => {
    // 09#82: b4 never claimed its redemption, so claim_tail (SH-CLM-2) sends claimRedemption, then claimPayout
    const src = raw('09_tail_clause');
    expect(src.steps[82]).toMatchObject({ op: 'claim_tail', actor: 'b4', series: 'S1' });
    const t = src.steps[82]!.t as string;
    const reverting = structuredClone(src);
    reverting.steps[82] = { t, op: 'expect_revert', call: { op: 'claim_tail', actor: 'b4', series: 'S1' }, error: 'NoTailDue' };
    /** b4's claimPayout at #82 raises NoTailDue, after changing the engine when `leak` */
    const refusePayout = (world: MercesWorld, leak: boolean) => {
      const engine = world.chain.engine;
      const execute = engine.execute.bind(engine);
      const b4 = world.actors.address('b4');
      engine.execute = ((cmd, actor, ctx) => {
        if (cmd.kind === 'claimPayout' && (actor as { signers?: string[] }).signers?.[0] === b4 && world.now() === Number(t)) {
          if (leak) engine.state.txCount += 1000;
          throw new ChainError('NotPermitted', 'claimPayout refused by the test', { stage1: 'NoTailDue' });
        }
        return execute(cmd, actor, ctx);
      }) as typeof engine.execute;
    };
    const replay = async (vector: LoadedVector, leak?: boolean) => {
      const world = await MercesWorld.create(vector, { personality: 'solana' });
      if (leak !== undefined) refusePayout(world, leak);
      try {
        return { run: await replayVector(world, vector, { until: 82 }), world };
      } finally {
        await world.close();
      }
    };
    const v = fromJson(reverting, '09_tail_clause');
    // claimRedemption went through, claimPayout reverted cleanly: the runner undid the first, and says so
    const { run } = await replay(v, false);
    expect(run.issues).toEqual([]);
    expect(run.status).toBe('PASS');
    expect(run.runnerAtomic).toEqual([{ index: 82, op: 'expect_revert claim_tail', shimId: 'SH-CLM-2', rolledBack: 1 }]);
    expect(run.shims['SH-CLM-2']).toBe(1);
    const md = renderParity([{ backend: 'merces', runs: [{ ...run, expected: EXPECTED_S1['09']!, atExpected: true }], notRun: [], proofs: { verified: 0, invalid: 0, cacheHits: 0 }, ok: true }], { dir: 'x' });
    expect(md).toContain('- 09_tail_clause #82 `expect_revert claim_tail` (SH-CLM-2) on merces/solana: 1 transaction undone by the runner');
    expect(md).toMatch(/\| SH-CLM-2 \(runner-atomic\) \| `claim_tail` \|[^\n]*\| 09 \|/);
    // the second transaction's own revert is checked against the state just before it, not the op's start
    const leaked = (await replay(v, true)).run;
    expect(leaked.issues).toEqual([{ index: 82, op: 'expect_revert claim_tail', kind: 'fail', message: 'claim_tail reverted with NoTailDue but changed the state' }]);
    // a shim row not marked runner-atomic may not send two transactions for one call
    const row = SHIM_BY_ID.get('SH-CLM-2') as { runnerAtomic?: true };
    delete row.runnerAtomic;
    try {
      const unmarked = (await replay(fromJson(src, '09_tail_clause'))).run;
      expect(unmarked.status).toBe('FAIL');
      expect(unmarked.issues).toEqual([{ index: 82, op: 'claim_tail', kind: 'fail', message: 'claim_tail went through 2 transactions, but shim row SH-CLM-2 is not marked runner-atomic' }]);
    } finally {
      row.runnerAtomic = true;
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

  it('every op the vectors use has a translator; the S1 gaps name the same milestones as the op map', () => {
    for (const f of listVectorFiles(VECTORS)) {
      for (const s of loadVector(f).steps) {
        const op = s.op === 'expect_revert' ? s.call.op : s.op;
        if (op !== 'expect') expect(TRANSLATORS[op as keyof typeof TRANSLATORS], op).toBeDefined();
      }
    }
    const notInS1 = Object.fromEntries(Object.entries(STAGE1_OP_MAP).filter(([, m]) => m.kind === 'not-in-s1').map(([op, m]) => [op, m.milestone]));
    expect(NOT_IN_S1).toEqual(notInS1);
    // cause S2-RH, S2-MS: the raise's ops run directly since S2, `commit_bid` aside (our commitment until S4)
    expect(NOT_IN_S1).not.toHaveProperty('cancel_raise');
    expect(NOT_IN_S1).not.toHaveProperty('register_holder');
    for (const op of ['open_raise', 'cancel_raise', 'reveal_bid', 'begin_settlement', 'finalize_settlement', 'process_bid', 'deliver_bid', 'register_holder']) expect(STAGE1_OP_MAP[op]?.kind, op).toBe('direct');
    expect(STAGE1_OP_MAP.commit_bid).toMatchObject({ kind: 'shim', shim: 'SH-AUC-2' });
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

  // the S1 gate (plan WP13): one full run of every target on both personalities, shared by the next two tests
  let full: RunReport | undefined;
  const fullRun = async (): Promise<RunReport> => (full ??= await runStage1Vectors({ dir: VECTORS, backend: 'merces' }));

  it('every S1 target is at its expected status on both personalities', async () => {
    const report = await fullRun();
    expect(report.runs.map((r) => `${r.id}/${r.world}`)).toEqual(TARGETS_S1.flatMap((id) => [`${id}/merces/solana`, `${id}/merces/monad`]));
    for (const r of report.runs) expect(r.atExpected, `${r.vector} ${r.world}: ${r.status}`).toBe(true);
    expect(report.ok).toBe(true);
    // the report proofs went through the ports' Groth16 verifier: 04#66 passes only because its pairing check fails
    // (its signals match the claimed payment), so a verifier that accepted everything would leave 04 off its status
    expect(report.proofs.verified).toBeGreaterThan(0);
  }, 180_000);

  it('the shim table is written into VECTOR_PARITY.md under "Shims (not parity)", and a merces run carries public values only', async () => {
    const report = await fullRun();
    expect(report.runs).toHaveLength(TARGETS_S1.length * 2);
    expect(report.notRun).toHaveLength(25 - TARGETS_S1.length);
    const md = renderParity([report], { dir: '$STAGE1_PATH/packages/vectors' });
    const section = md.slice(md.indexOf('## Shims (not parity)'));
    expect(section.length).toBeGreaterThan(0);
    for (const s of SHIM_BY_ID.values()) expect(section, s.id).toContain(`| ${s.id}`);
    // cause S2-MS: the commitment is the raise's only shim left (SH-AUC-3..6 retired); it goes in S4
    expect(section).toMatch(/\| SH-AUC-2 \| `commit_bid` \|[^\n]*\| S4 \| 01, 04, 05, 06, 07, 09, 11, 19, 23, 25 \|/);
    expect(section).not.toMatch(/SH-AUC-[3-6]/);
    expect(section).toMatch(/\| BLK-1 \(BLOCKED\) \| `retire_if_capped` \|/);
    // review finding "VECTOR_PARITY.md 'Used in' leaves out shims exercised by expect_revert steps": the calls of
    // passing reverts went through their shims too (amend_terms at 05#44 and 11#45, redeem at 01#33, 05#43, 11#43)
    for (const id of ['05', '11']) for (const r of report.runs.filter((x) => x.id === id)) expect(r.shims['SH-AMD-1'], `${id} ${r.world}`).toBe(1);
    for (const r of report.runs.filter((x) => x.id === '01')) expect(r.shims['SH-RED-1'], r.world).toBe(1);
    expect(section).toMatch(/\| SH-AMD-1 \| `amend_terms` \|[^\n]*\| S4 \| 05, 11 \|/);
    expect(section).toMatch(/\| SH-RED-1 \| `redeem` \|[^\n]*\| — \| 01, 05, 06, 09, 11, 23, 25 \|/);
    expect(section).toMatch(/\| SH-CLM-2 \(runner-atomic\) \| `claim_tail` \|/);
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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_S1,
  ReferenceWorld,
  SHIM_BY_ID,
  TARGETS_S1,
  atExpected,
  backendAvailable,
  checkRevert,
  compareExpect,
  fromJson,
  listVectorFiles,
  loadVector,
  renderParity,
  runStage1Vectors,
  shutdown,
  type LoadedVector,
  type RunReport,
  type World,
} from '../src/stage1-vectors/index.ts';
import { STAGE1_OP_MAP } from '../src/steps/vectors.ts';

const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const raw = (name: string) => JSON.parse(readFileSync(join(VECTORS, `${name}.json`), 'utf8')) as Record<string, unknown> & { steps: Record<string, unknown>[] };

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

  it('a revert that changes the state fails, and a non-protocol exception is reported by class only', async () => {
    const v = loadVector(join(VECTORS, '01_happy_path.json'));
    const step = v.steps.find((s) => s.op === 'expect_revert')!;
    if (step.op !== 'expect_revert') throw new Error('unreachable');
    let state = 'a';
    const fake = (thrown: unknown, mutate: boolean): World => ({
      backend: 'reference',
      label: 'fake',
      setTime: () => {},
      apply: async () => {
        if (mutate) state = 'b';
        throw thrown;
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
  it('every target expects PASS (waivers only for blocked or n/a rows); the others are NOT-IN-S1 with a milestone', () => {
    expect(Object.keys(EXPECTED_S1).sort()).toEqual(listVectorFiles(VECTORS).map((f) => f.split('/').at(-1)!.slice(0, 2)));
    for (const [id, e] of Object.entries(EXPECTED_S1)) {
      if ((TARGETS_S1 as readonly string[]).includes(id)) {
        expect(e.status, id).not.toBe('NOT-IN-S1');
        for (const w of e.waivers ?? []) expect(['blocked', 'n/a']).toContain(SHIM_BY_ID.get(w.id)?.kind);
      } else expect(e.status === 'NOT-IN-S1' && !!e.milestone, id).toBe(true);
    }
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

  it('a backend that does not exist yet is refused, not silently skipped', async () => {
    if (backendAvailable('merces')) return;
    await expect(runStage1Vectors({ dir: VECTORS, backend: 'merces' })).rejects.toThrow(/merces backend is not available yet/);
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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MercesWorld,
  RunnerError,
  S3_CLAIM_SCENARIOS,
  SCENARIO_EXPECTED,
  loadScenario,
  loadScenarios,
  renderScenarios,
  replayVector,
  runScenarios,
  runStage1Vectors,
  shutdown,
  type RunReport,
  type Scenario,
  type Shim,
  type SyntheticShims,
} from '../src/stage1-vectors/index.ts';

/*
 * Our S3 claim scenarios (S3 plan WP2, amendment M5; cause S3-SC): the paths of Stage 1's claim family that no Stage 1
 * vector takes, in Stage 1's op format, replayed on Stage 1's own simulator, on ours and in lockstep. Their `expect`
 * values were taken from Stage 1's simulator on the composed steps (the reference backend must pass them).
 */
const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

afterAll(shutdown);

const own = (s: Scenario) => s.vector.steps.filter((_st, i) => isOwn(s, i));
/** Is the composed step `i` one of our own (from the `parts` description: "ours as #a-#b")? */
function isOwn(s: Scenario, i: number): boolean {
  return s.parts.some((p) => {
    const m = /^ours as #(\d+)(?:-#(\d+))?$/.exec(p);
    return !!m && i >= Number(m[1]) && i <= Number(m[2] ?? m[1]);
  });
}
const errorsOf = (s: Scenario) => own(s).flatMap((st) => (st.op === 'expect_revert' ? [`${st.call.op} ${st.error}`] : []));

describe('S3 claim scenarios: load', () => {
  it('seven scenarios, one per case (a)-(g), on the prefixes amendment M5 names', () => {
    const all = loadScenarios(S3_CLAIM_SCENARIOS, VECTORS);
    expect(all.map((s) => s.vector.id)).toEqual(['S3a', 'S3b', 'S3c', 'S3d', 'S3e', 'S3f', 'S3g']);
    expect(all.flatMap((s) => s.covers)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(all.map((s) => s.base)).toEqual(['09_tail_clause', '09_tail_clause', '09_tail_clause', '09_tail_clause', '11_extinguishment', '22_late_holder_tail_final', '05_cap_hit']);
    // (a) before 09's redemption at #64; (b)-(d) after it, around the tail funded at #80; (e) around 11's extinguishment
    // at #39; (f) on 22's prefix to #70; (g) on 05 around its retirement (#39) and burn (#47)
    expect(all.map((s) => s.parts[0])).toEqual(['09 #0-#63 as #0-#63', '09 #0-#64 as #0-#64', '09 #0-#81 as #0-#81', '09 #0-#64 as #0-#64', '11 #0-#38 as #0-#38', '22 #0-#70 as #0-#70', '05 #0-#36 as #0-#36']);
    expect(all.find((s) => s.vector.id === 'S3f')!.parts).toEqual(['22 #0-#70 as #0-#70', 'ours as #71-#81']);
    // the cases each reaches, by the Stage 1 errors its own reverts expect
    expect(Object.fromEntries(all.map((s) => [s.vector.id, errorsOf(s)]))).toEqual({
      S3a: ['claim_tail NotRedeemed', 'claim_tail NotRedeemed', 'claim_tail NotRedeemed'],
      S3b: ['claim_tail HolderNotRegistered', 'claim_tail HolderNotRegistered', 'claim_tail HolderNotRegistered'],
      S3c: ['claim_tail NoRedeemedUnits', 'claim_tail NoRedeemedUnits'],
      S3d: [],
      S3e: ['claim_final TerminalStatus', 'claim_final HolderNotRegistered', 'burn_retired TerminalStatus', 'claim_tail NotRedeemed'],
      S3f: ['claim_final TerminalStatus'],
      S3g: ['burn_retired TerminalStatus', 'claim_tail NotRedeemed', 'claim_final TerminalStatus'],
    });
    // their own actions: tail and final claims, the Retired burn, and what (c) and (f) need to get there
    const actions = (id: string) => own(all.find((s) => s.vector.id === id)!).flatMap((st) => (st.op === 'expect' || st.op === 'expect_revert' ? [] : [st.op]));
    expect(actions('S3c')).toEqual(['register_holder']);
    expect(actions('S3d')).toEqual(['claim_tail', 'claim_tail', 'claim_tail', 'claim_tail']);
    expect(actions('S3e')).toEqual(['claim_final']);
    expect(actions('S3f')).toEqual(['redeem', 'claim_redemption', 'extinguish', 'claim_final', 'claim_final', 'claim_tail', 'claim_final', 'claim_final']);
    expect(actions('S3g')).toEqual(['burn_retired', 'burn_retired', 'burn_retired', 'burn_retired']);
  });

  it('the composed vectors keep the base vectors\' privacy: no witness, no private terms, keys not enumerable', () => {
    for (const s of loadScenarios(S3_CLAIM_SCENARIOS, VECTORS)) {
      const text = JSON.stringify(s.vector, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
      for (const secret of ['witness', 'termsSalt', 'privateKey', 'seriesPrivate']) expect(text, `${s.vector.name} ${secret}`).not.toContain(secret);
      expect(Object.keys(s.vector)).not.toContain('keys');
      expect(s.vector.keys.attestor1?.role).toBe('attestor');
    }
  });

  it('refuses a file that is not a scenario, naming the problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 's3-claims-'));
    const base = JSON.parse(readFileSync(join(S3_CLAIM_SCENARIOS, 'S3a_tail_before_redeem.json'), 'utf8')) as Record<string, unknown>;
    const write = (name: string, patch: Record<string, unknown>) => {
      const f = join(dir, `${name}.json`);
      writeFileSync(f, JSON.stringify({ ...base, ...patch }));
      return f;
    };
    const step = { t: '1814486400', op: 'expect_revert', call: { op: 'claim_tail', actor: 'b1', series: 'S1' }, error: 'NotRedeemed' };
    const cases: [Record<string, unknown>, string][] = [
      [{ base: '99_nothing' }, 'S3a_tail_before_redeem: no Stage 1 vector 99_nothing'],
      [{ segments: [{ baseSteps: [0, 95] }] }, 'S3a_tail_before_redeem: segment 0 names steps outside 09_tail_clause (0-94)'],
      [{ segments: [{ baseSteps: [0, 63] }, { baseSteps: [60, 70] }] }, 'S3a_tail_before_redeem: segment 1 repeats or reorders steps of 09_tail_clause'],
      [{ segments: [{ baseSteps: [0, 80] }, { steps: [step] }] }, 'S3a_tail_before_redeem: step #81 goes back in time'],
      [{ segments: [{ baseSteps: [0, 63] }, { steps: [] }] }, 'S3a_tail_before_redeem: segment 1 is neither baseSteps nor steps'],
      [{ segments: [{ baseSteps: [0, 63] }, { steps: [{ ...step, call: { ...step.call, witness: {} } }] }] }, 'S3a_tail_before_redeem: a step of our own carries a witness'],
      [{ name: 'tail' }, 'bad.json: name must be <id>_<words>'],
    ];
    for (const [patch, message] of cases) {
      const f = write(patch.name === 'tail' ? 'bad' : 'S3a', patch);
      expect(() => loadScenario(f, VECTORS)).toThrow(new RunnerError(message));
    }
    expect(() => loadScenarios(S3_CLAIM_SCENARIOS, VECTORS, ['S3z'])).toThrow(new RunnerError('no scenario matches S3z'));
    expect(loadScenarios(S3_CLAIM_SCENARIOS, VECTORS, ['S3f', 'S3a_tail_before_redeem']).map((s) => s.vector.id)).toEqual(['S3a', 'S3f']);
  });
});

describe('S3 claim scenarios: replay', () => {
  const reports: Partial<Record<'reference' | 'merces' | 'lockstep', RunReport>> = {};
  let scenarios: Scenario[] = [];

  it("Stage 1's own simulator passes every scenario, its own expects included", async () => {
    const r = await runScenarios({ vectorsDir: VECTORS, backend: 'reference' });
    scenarios = r.scenarios;
    reports.reference = r.report;
    expect(r.report.runs.map((x) => [x.id, x.world, x.status, x.executed === x.total])).toEqual(scenarios.map((s) => [s.vector.id, 'reference', 'PASS', true]));
    for (const run of r.report.runs) expect(run.expected).toEqual(SCENARIO_EXPECTED);
    expect(r.report.ok).toBe(true);
  }, 120_000);

  it('the merces backend passes every scenario on both personalities, the claims running directly', async () => {
    const r = await runScenarios({ vectorsDir: VECTORS, backend: 'merces' });
    reports.merces = r.report;
    expect(r.report.runs).toHaveLength(14);
    for (const run of r.report.runs) {
      expect(run.issues, `${run.vector} ${run.world}`).toEqual([]);
      expect([run.status, run.executed], `${run.vector} ${run.world}`).toEqual(['PASS', run.total]);
      expect(run.runnerAtomic).toEqual([]);
      // no shim stands in for the claim family any more (S3-SH); `claim` is SH-CLM-1 until WP3
      for (const id of Object.keys(run.shims)) expect(['SH-REG-1', 'SH-REG-2', 'SH-REG-3', 'SH-REG-4', 'SH-AUC-2', 'SH-REP-1', 'SH-PAY-1', 'SH-CLM-1', 'SH-RED-1', 'SH-EXT-1', 'SH-AMD-1'], `${run.vector} ${id}`).toContain(id);
    }
    expect(r.report.ok).toBe(true);
  }, 180_000);

  it('lockstep: the full snapshots of both backends agree after every step of every scenario, on both personalities', async () => {
    const r = await runScenarios({ vectorsDir: VECTORS });
    reports.lockstep = r.report;
    expect(r.report.backend).toBe('lockstep');
    expect(r.report.runs.map((x) => `${x.id}/${x.world}`)).toEqual(scenarios.flatMap((s) => [`${s.vector.id}/lockstep/solana`, `${s.vector.id}/lockstep/monad`]));
    for (const run of r.report.runs) {
      expect(run.issues, `${run.vector} ${run.world}`).toEqual([]);
      expect([run.status, run.executed, run.atExpected], `${run.vector} ${run.world}`).toEqual(['PASS', run.total, true]);
    }
    expect(r.report.ok).toBe(true);
  }, 180_000);

  it("the scenarios' figures are Stage 1's: a changed value of one of our expects fails on Stage 1's simulator and on ours", async () => {
    const s = loadScenario(join(S3_CLAIM_SCENARIOS, 'S3f_final_after_redemption.json'), VECTORS);
    const last = s.vector.steps.length - 1;
    const step = s.vector.steps[last] as unknown as { op: string; balances: Record<string, { stable: string }> };
    expect(step.op).toBe('expect');
    // b1, b2 and b3 each hold 100 of the 400 units at redemption: 10,500 USDC unvested at the extinguishment is 26.25 a
    // unit, 2,625 each on top of what their redemption paid (P_redeem x 100 and the pending payout)
    expect([step.balances.b1!.stable, step.balances.b2!.stable, step.balances.b3!.stable, step.balances.b4!.stable]).toEqual(['75017017500', '75017017500', '75017017500', '58790000000']);
    // edit the loaded copy (the file is left alone)
    step.balances.b2!.stable = '75017017501';
    for (const backend of ['reference', 'merces'] as const) {
      const edited = (await runStage1Vectors({ vectors: [s.vector], backend, expected: SCENARIO_EXPECTED, personalities: ['solana'] })).runs[0]!;
      expect(edited.status, backend).toBe('FAIL');
      expect(edited.issues.map((i) => [i.index, i.message, i.diffs]), backend).toEqual([[last, '1 expected value(s) differ', [{ path: 'balances.b2.stable', expected: '75017017501', actual: '75017017500' }]]]);
    }
  }, 120_000);

  // the retired shims would not pass: SH-CLM-2's claimPayout pays a late-registered wallet nothing and does not refuse
  // (S3c expects NoRedeemedUnits), SH-CLM-3's claimPayout runs on a Redeemed series (S3f expects TerminalStatus)
  it('the scenarios catch the retired shims: SH-CLM-2 fails (c) and SH-CLM-3 fails (f)', async () => {
    const row = (id: string, op: string): Shim => ({ id, ops: [op], call: 'as retired in S3 WP2', why: 'test only', removedIn: 'S3', kind: 'shim', runnerAtomic: true });
    const retired: SyntheticShims = {
      rows: [row('SH-CLM-2', 'claim_tail'), row('SH-CLM-3', 'claim_final')],
      translators: {
        claim_tail: (ctx, c) => ({
          kind: 'shim',
          shimId: 'SH-CLM-2',
          run: async () => {
            const seriesId = ctx.seriesBook(c.series).seriesId;
            const wallet = ctx.actors.wallet(c.actor);
            const p = ctx.seriesState(c.series).positions.get(wallet.address);
            if (p && p.redeemedUnits === 0n && p.units > 0n) await ctx.send(wallet, { kind: 'claimRedemption', seriesId });
            await ctx.send(wallet, { kind: 'claimPayout', seriesId });
          },
        }),
        claim_final: (ctx, c) => ({
          kind: 'shim',
          shimId: 'SH-CLM-3',
          run: async () => {
            await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimPayout', seriesId: ctx.seriesBook(c.series).seriesId });
          },
        }),
      },
    };
    const first = async (file: string) => {
      const s = loadScenario(join(S3_CLAIM_SCENARIOS, file), VECTORS);
      const world = await MercesWorld.create(s.vector, { personality: 'solana', synthetic: retired });
      try {
        const run = await replayVector(world, s.vector);
        return run.issues.find((i) => i.kind === 'fail');
      } finally {
        await world.close();
      }
    };
    expect(await first('S3c_late_register_no_redeemed_units.json')).toMatchObject({ index: 83, op: 'expect_revert claim_tail', message: 'expected revert NoRedeemedUnits for claim_tail, but the call succeeded' });
    expect(await first('S3f_final_after_redemption.json')).toMatchObject({ index: 72, op: 'expect_revert claim_final', message: 'expected revert TerminalStatus for claim_final, but the call succeeded' });
  }, 120_000);

  it('VECTOR_PARITY.md gets one row per scenario with its result on every world, and its description', () => {
    const all = [reports.reference!, reports.merces!, reports.lockstep!];
    expect(all.every(Boolean)).toBe(true);
    const md = renderScenarios(scenarios, all).join('\n');
    expect(md).toContain("## S3 claim scenarios (ours, lockstep against Stage 1's Simulator)");
    expect(md).toContain('| Scenario | Covers | Built from | reference | merces/solana | merces/monad | lockstep/solana | lockstep/monad |');
    expect(md).toContain('| S3f_final_after_redemption | (f) | 22 #0-#70 as #0-#70; ours as #71-#81 | PASS 82/82 | PASS 82/82 | PASS 82/82 | PASS 82/82 | PASS 82/82 |');
    for (const s of scenarios) expect(md).toContain(`- ${s.vector.name}: ${s.vector.description}`);
    expect(md).not.toContain('### Scenario findings');
    // a failing run is listed with its findings
    const failing: RunReport = { ...reports.lockstep!, runs: [{ ...reports.lockstep!.runs[0]!, status: 'FAIL', atExpected: false, issues: [{ index: 64, op: 'expect_revert claim_tail', kind: 'fail', message: 'boom' }] }] };
    expect(renderScenarios(scenarios.slice(0, 1), [failing]).join('\n')).toContain('### Scenario findings\n\n- S3a_tail_before_redeem on lockstep/solana: FAIL, expected PASS\n  - #64 `expect_revert claim_tail`: boom');
    // public values only: no key, salt or witness of the base vectors
    for (const f of new Set(scenarios.map((s) => s.base))) {
      const v = JSON.parse(readFileSync(join(VECTORS, `${f}.json`), 'utf8')) as { keys: Record<string, { privateKey: string }>; seriesPrivate: Record<string, { termsPlain: { termsSalt: string } }> };
      for (const k of Object.values(v.keys)) expect(md.toLowerCase()).not.toContain(k.privateKey.slice(2).toLowerCase());
      for (const p of Object.values(v.seriesPrivate)) expect(md).not.toContain(p.termsPlain.termsSalt);
    }
  });

  it('every scenario file is listed in the fixtures directory and loads', () => {
    const files = readdirSync(S3_CLAIM_SCENARIOS).filter((f) => f.endsWith('.json')).sort();
    expect(files.map((f) => f.replace(/\.json$/, ''))).toEqual(scenarios.map((s) => s.vector.name));
  });
});

describe('stage1:vectors --scenarios', () => {
  it('replays the scenarios in lockstep by default and exits 0; refuses a gate or --out', () => {
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    const stdout = execFileSync(tsx, ['packages/stage1-sync/src/stage1-vectors/cli.ts', '--scenarios', '--only', 'S3a,S3g', '--personality', 'monad'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(stdout).toContain('backend lockstep: 2/2 at expected status');
    expect(stdout).toMatch(/S3a_tail_before_redeem \[lockstep\/monad\] PASS 67\/67/);
    expect(stdout).toMatch(/S3g_burn_retired \[lockstep\/monad\] PASS 59\/59/);
    expect(stdout).toContain('OK: 2/2 PASS, 2/2 at expected status');
    let code = 0;
    let stderr = '';
    try {
      execFileSync(tsx, ['packages/stage1-sync/src/stage1-vectors/cli.ts', '--scenarios', '--until', '3'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(2);
    expect(stderr).toContain('--scenarios takes no --until, --stop-before or --out');
  }, 180_000);
});

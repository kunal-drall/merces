import type { ExpectRevertStep, Step } from '@merces/reference';
import { compareExpect, fxRequestOf, type Diff } from './compare.ts';
import { describeRaised, RunnerError } from './errors.ts';
import { splitDivergences, waiverFor, type Divergence, type Waiver } from './expected.ts';
import { stableConserved, unitsConserved } from './invariants.ts';
import { callOf, opLabel, type LoadedVector } from './load.ts';
import { checkRevert } from './revert.ts';
import type { Applied, Backend, VectorPersonality, World } from './world.ts';

/**
 * How a replay ended (S1 plan §5.6 vocabulary; S2 adds PASS-WITH-DIVERGENCES: every difference is a recorded entry of
 * the divergence register, `divergences.ts`).
 */
export type VectorStatus = 'PASS' | 'PASS-WITH-WAIVERS' | 'PASS-WITH-DIVERGENCES' | 'BLOCKED' | 'FAIL';

/**
 * One finding at a step. Messages and diffs carry public facts only (names, indices, error names, expect values).
 * `divergence`: differences equal to recorded entries of the register row `divergence` (accepted, not parity).
 */
export interface StepIssue {
  index: number;
  /** the step's op; `expect_revert <call op>` for a revert */
  op: string;
  kind: 'fail' | 'blocked' | 'n/a' | 'divergence';
  message: string;
  diffs?: Diff[];
  /** the shim-table row of a blocked or n/a step */
  shimId?: string;
  /** set when the step is waived by the vector's expectation */
  waived?: boolean;
  /** a `divergence` issue: its register row (`DIV-NRC-1`) */
  divergence?: string;
}

/** Is the issue a finding (a failure, or a step not run and not waived)? Waived steps and accepted divergences are not. */
export function isFinding(i: StepIssue): boolean {
  return i.kind === 'fail' || ((i.kind === 'blocked' || i.kind === 'n/a') && !i.waived);
}

/**
 * An expected revert that was atomic by the runner's doing, not the engine's: transactions of the same call went
 * through before one reverted, and the world undid them (a runner-atomic shim row; not parity).
 */
export interface RunnerAtomicStep {
  index: number;
  /** `expect_revert <call op>` */
  op: string;
  shimId?: string;
  /** transactions the runner undid */
  rolledBack: number;
}

export interface VectorRun {
  id: string;
  vector: string;
  world: string;
  /** `lockstep`: both backends side by side (`oracle.ts`) */
  backend: Backend | 'lockstep';
  personality?: VectorPersonality;
  status: VectorStatus;
  /** steps replayed (expects and reverts included) */
  executed: number;
  total: number;
  /** set when the replay did not reach the end */
  stopped?: { index: number; reason: 'until' | 'stop-before' | 'diverged' | 'too-many-failures' };
  issues: StepIssue[];
  /** shim-table rows the world ran ops through (the calls of passing `expect_revert` steps included), with how many steps */
  shims: Record<string, number>;
  /** expected reverts the runner made atomic (see `RunnerAtomicStep`) */
  runnerAtomic: RunnerAtomicStep[];
  ms: number;
}

export interface ReplayOptions {
  /** last step index to replay (inclusive) */
  until?: number;
  /** stop before the first step whose op (or nested call op) is this */
  stopBefore?: string;
  /** steps this backend may leave unrun */
  waivers?: readonly Waiver[];
  /** known divergences at `expect` steps (`Expected.divergences`): accepted when equal, a failure when moved or stale */
  divergences?: readonly Divergence[];
  /** stop after this many failing steps (default 25) */
  maxFailures?: number;
}

/** The status a list of issues amounts to. */
export function statusOf(issues: readonly StepIssue[]): VectorStatus {
  if (issues.some((i) => i.kind === 'fail')) return 'FAIL';
  if (issues.some(isFinding)) return 'BLOCKED';
  if (issues.some((i) => i.kind === 'divergence')) return 'PASS-WITH-DIVERGENCES';
  if (issues.some((i) => i.waived)) return 'PASS-WITH-WAIVERS';
  return 'PASS';
}

/**
 * Replay one vector on one world (S1 plan §5.2). The clock moves to each step's `t` first; `expect` compares the
 * world's snapshot and checks the unit supply; `expect_revert` runs the revert check; actions run through the world.
 * After every step Σ stablecoin must equal Σ fund. An action that fails, a revert check whose call went through or
 * changed the state, and a broken stablecoin invariant end the replay (the states have diverged); `expect` mismatches
 * do not. At an `expect`, a difference equal to a recorded divergence entry of the step is accepted (an issue of kind
 * `divergence`); another value at a recorded path fails, and so does an entry of the step whose difference did not
 * occur (a stale divergence: the behaviour it records has changed, so the entry must go).
 */
export async function replayVector(world: World, vector: LoadedVector, opts: ReplayOptions = {}): Promise<VectorRun> {
  const started = Date.now();
  const issues: StepIssue[] = [];
  const shims: Record<string, number> = {};
  const runnerAtomic: RunnerAtomicStep[] = [];
  const maxFailures = opts.maxFailures ?? 25;
  let funded = 0n;
  let executed = 0;
  let stopped: VectorRun['stopped'];

  const fail = (index: number, step: Step, message: string, diffs?: Diff[]) => {
    issues.push({ index, op: opLabel(step), kind: 'fail', message, ...(diffs ? { diffs } : {}) });
  };
  const notRun = (index: number, step: Step, applied: Applied) => {
    const kind = applied.kind === 'n/a' ? 'n/a' : 'blocked';
    const waiver = waiverFor(opts.waivers, index, step, applied);
    const what = kind === 'n/a' ? 'not applicable on this backend; not run' : 'cannot run on this backend yet; not run';
    issues.push({ index, op: opLabel(step), kind, message: applied.note ? `${what} (${applied.note})` : what, ...(applied.shimId ? { shimId: applied.shimId } : {}), ...(waiver ? { waived: true } : {}) });
  };
  const countShim = (applied: Applied) => {
    if (applied.kind === 'shim' && applied.shimId) shims[applied.shimId] = (shims[applied.shimId] ?? 0) + 1;
  };

  for (const [index, step] of vector.steps.entries()) {
    if (opts.until !== undefined && index > opts.until) {
      stopped = { index, reason: 'until' };
      break;
    }
    const call = callOf(step);
    if (opts.stopBefore && (step.op === opts.stopBefore || call?.op === opts.stopBefore)) {
      stopped = { index, reason: 'stop-before' };
      break;
    }
    if (issues.filter((i) => i.kind === 'fail').length >= maxFailures) {
      stopped = { index, reason: 'too-many-failures' };
      break;
    }
    executed++;
    let diverged = false;
    try {
      world.setTime(BigInt(step.t));
      if (step.op === 'expect') {
        const snapshot = world.snapshot(step.series ?? null, fxRequestOf(step as unknown as Record<string, unknown>));
        const diffs = compareExpect(step as unknown as Record<string, unknown>, snapshot);
        const { accepted, failed, moved, stale } = splitDivergences(opts.divergences, index, diffs);
        if (failed.length) fail(index, step, `${failed.length} expected value(s) differ${moved.length ? ` (${moved.length} at a recorded divergence path with another value: ${moved.join(', ')})` : ''}`, failed);
        for (const id of [...new Set(accepted.map((d) => d.id))]) {
          const mine = accepted.filter((d) => d.id === id).map(({ id: _id, ...d }) => d);
          issues.push({ index, op: opLabel(step), kind: 'divergence', divergence: id, message: `known divergence ${id}: ${mine.length} field(s) differ as recorded (accepted, not parity)`, diffs: mine });
        }
        for (const e of stale) fail(index, step, `stale divergence ${e.id}: ${e.path} no longer differs (recorded: Stage 1 ${JSON.stringify(e.stage1)}, ours ${JSON.stringify(e.ours)}); remove the entry`);
        if (step.series) {
          const units = unitsConserved(world, step.series);
          if (units) fail(index, step, units);
        }
      } else if (step.op === 'expect_revert') {
        const r = await checkRevert(world, step as ExpectRevertStep);
        if (r.result === 'fail') {
          fail(index, step, r.message);
          diverged = r.diverged;
        } else if (r.result === 'skipped') notRun(index, step, r.applied);
        else {
          // the call went through its translation (a shim, maybe) before it raised the expected error
          if (r.applied) countShim(r.applied);
          if (r.rolledBack > 0) runnerAtomic.push({ index, op: opLabel(step), ...(r.applied?.shimId ? { shimId: r.applied.shimId } : {}), rolledBack: r.rolledBack });
        }
      } else {
        if (step.op === 'fund') funded += BigInt(step.amount);
        try {
          const applied = await world.apply(call!);
          if (applied.kind === 'blocked' || applied.kind === 'n/a') notRun(index, step, applied);
          else countShim(applied);
        } catch (e) {
          // a shim's own check failed (the two models diverged): reported with its public message below
          if (e instanceof RunnerError) throw e;
          const raised = world.classify(e);
          fail(index, step, raised.protocol ? `unexpected revert ${raised.name}` : `unexpected ${describeRaised(raised)}`);
          diverged = true;
        }
      }
      if (!diverged) {
        const stable = stableConserved(world, funded);
        if (stable) {
          fail(index, step, stable);
          diverged = true;
        }
      }
    } catch (e) {
      // the runner or the world itself failed (time going backwards, a snapshot of an unknown series, …)
      fail(index, step, e instanceof RunnerError ? e.message : `runner fault: ${describeRaised(world.classify(e))}`);
      diverged = true;
    }
    if (diverged) {
      if (index + 1 < vector.steps.length) stopped = { index: index + 1, reason: 'diverged' };
      break;
    }
  }
  // an entry recorded at a step that ran but is not an `expect` is never checked: a broken expectation, not a pass
  for (const e of opts.divergences ?? []) {
    const step = vector.steps[e.step];
    if (e.step < executed && step && step.op !== 'expect') fail(e.step, step, `divergence entry ${e.id} at #${e.step} (${e.path}) names a step that is not an expect`);
  }
  return {
    id: vector.id,
    vector: vector.name,
    world: world.label,
    backend: world.backend,
    status: statusOf(issues),
    executed,
    total: vector.steps.length,
    ...(stopped ? { stopped } : {}),
    issues,
    shims,
    runnerAtomic,
    ms: Date.now() - started,
  };
}

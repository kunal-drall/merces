import type { ExpectRevertStep, Step } from '@merces/reference';
import { compareExpect, fxRequestOf, type Diff } from './compare.ts';
import { describeRaised, RunnerError } from './errors.ts';
import type { Waiver } from './expected.ts';
import { stableConserved, unitsConserved } from './invariants.ts';
import { callOf, type LoadedVector } from './load.ts';
import { checkRevert } from './revert.ts';
import type { Applied, Backend, VectorPersonality, World } from './world.ts';

/** How a replay ended (S1 plan §5.6 vocabulary). */
export type VectorStatus = 'PASS' | 'PASS-WITH-WAIVERS' | 'BLOCKED' | 'FAIL';

/** One finding at a step. Messages and diffs carry public facts only (names, indices, error names, expect values). */
export interface StepIssue {
  index: number;
  /** the step's op; `expect_revert <call op>` for a revert */
  op: string;
  kind: 'fail' | 'blocked' | 'n/a';
  message: string;
  diffs?: Diff[];
  /** the shim-table row of a blocked or n/a step */
  shimId?: string;
  /** set when the step is waived by the vector's expectation */
  waived?: boolean;
}

export interface VectorRun {
  id: string;
  vector: string;
  world: string;
  backend: Backend;
  personality?: VectorPersonality;
  status: VectorStatus;
  /** steps replayed (expects and reverts included) */
  executed: number;
  total: number;
  /** set when the replay did not reach the end */
  stopped?: { index: number; reason: 'until' | 'stop-before' | 'diverged' | 'too-many-failures' };
  issues: StepIssue[];
  /** shim-table rows the world ran ops through, with how many steps */
  shims: Record<string, number>;
  ms: number;
}

export interface ReplayOptions {
  /** last step index to replay (inclusive) */
  until?: number;
  /** stop before the first step whose op (or nested call op) is this */
  stopBefore?: string;
  /** steps this backend may leave unrun */
  waivers?: readonly Waiver[];
  /** stop after this many failing steps (default 25) */
  maxFailures?: number;
}

function opLabel(step: Step): string {
  return step.op === 'expect_revert' ? `expect_revert ${step.call.op}` : step.op;
}

/** The status a list of issues amounts to. */
export function statusOf(issues: readonly StepIssue[]): VectorStatus {
  if (issues.some((i) => i.kind === 'fail')) return 'FAIL';
  if (issues.some((i) => i.kind !== 'fail' && !i.waived)) return 'BLOCKED';
  if (issues.some((i) => i.waived)) return 'PASS-WITH-WAIVERS';
  return 'PASS';
}

/**
 * Replay one vector on one world (S1 plan §5.2). The clock moves to each step's `t` first; `expect` compares the
 * world's snapshot and checks the unit supply; `expect_revert` runs the revert check; actions run through the world.
 * After every step Σ stablecoin must equal Σ fund. An action that fails, a revert check whose call went through or
 * changed the state, and a broken stablecoin invariant end the replay (the states have diverged); `expect` mismatches
 * do not.
 */
export async function replayVector(world: World, vector: LoadedVector, opts: ReplayOptions = {}): Promise<VectorRun> {
  const started = Date.now();
  const issues: StepIssue[] = [];
  const shims: Record<string, number> = {};
  const maxFailures = opts.maxFailures ?? 25;
  let funded = 0n;
  let executed = 0;
  let stopped: VectorRun['stopped'];

  const fail = (index: number, step: Step, message: string, diffs?: Diff[]) => {
    issues.push({ index, op: opLabel(step), kind: 'fail', message, ...(diffs ? { diffs } : {}) });
  };
  const notRun = (index: number, step: Step, applied: Applied) => {
    const kind = applied.kind === 'n/a' ? 'n/a' : 'blocked';
    const waiver = opts.waivers?.find((w) => w.step === index && (!applied.shimId || w.id === applied.shimId));
    issues.push({ index, op: opLabel(step), kind, message: kind === 'n/a' ? 'not applicable on this backend; not run' : 'cannot run on this backend yet; not run', ...(applied.shimId ? { shimId: applied.shimId } : {}), ...(waiver ? { waived: true } : {}) });
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
        if (diffs.length) fail(index, step, `${diffs.length} expected value(s) differ`, diffs);
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
      } else {
        if (step.op === 'fund') funded += BigInt(step.amount);
        try {
          const applied = await world.apply(call!);
          if (applied.kind === 'blocked' || applied.kind === 'n/a') notRun(index, step, applied);
          else countShim(applied);
        } catch (e) {
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
    ms: Date.now() - started,
  };
}

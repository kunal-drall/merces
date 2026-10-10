import type { ExpectRevertStep, Step } from '@merces/reference';
import { compareExpect, fxRequestOf, type Diff } from './compare.ts';
import { RunnerError, describeRaised } from './errors.ts';
import type { Waiver } from './expected.ts';
import { callOf, type LoadedVector } from './load.ts';
import { MercesWorld } from './merces-world.ts';
import { ReferenceWorld } from './reference-world.ts';
import { checkRevert } from './revert.ts';
import { statusOf, type StepIssue, type VectorRun } from './run.ts';
import type { Applied, VectorPersonality } from './world.ts';

/**
 * Lockstep mode (S1 plan §5.1 `oracle.ts`): the reference backend (Stage 1's own simulator) and the merces backend
 * replay the same vector side by side, and the replay stops at the first step after which they disagree, naming the
 * fields. It is a debugging aid for the engine work packages: a vector's own `expect`s check a few instants, lockstep
 * checks every instant.
 *
 * - After every action, while no series is in the middle of a multi-step settlement on Stage 1's side (which our
 *   one-step model cannot mirror: `ReferenceWorld.inFlight`), the full snapshot of every series is compared (every
 *   field, not only those an `expect` carries).
 * - At an `expect`, the full snapshot of its series is compared, in flight or not.
 * - An action must succeed on both; an `expect_revert` must revert on both with the same Stage 1 error and leave the
 *   merces state unchanged (a merces op that is blocked or n/a there is noted, not a divergence).
 * - An action the merces backend cannot run (blocked, n/a) is a divergence: the states part from there on.
 *
 * Diffs carry public values only (the snapshots are the `expect` views).
 */
export interface LockstepOptions {
  until?: number;
  stopBefore?: string;
  waivers?: readonly Waiver[];
}

const MAX_DIFFS = 40;

function opLabel(step: Step): string {
  return step.op === 'expect_revert' ? `expect_revert ${step.call.op}` : step.op;
}

export async function replayLockstep(vector: LoadedVector, personality: VectorPersonality, opts: LockstepOptions = {}): Promise<VectorRun> {
  const started = Date.now();
  const ref = await ReferenceWorld.create(vector);
  const mer = await MercesWorld.create(vector, { personality });
  const issues: StepIssue[] = [];
  const shims: Record<string, number> = {};
  let executed = 0;
  let stopped: VectorRun['stopped'];

  const diverge = (index: number, step: Step, message: string, diffs?: Diff[]): void => {
    issues.push({ index, op: opLabel(step), kind: 'fail', message, ...(diffs?.length ? { diffs: diffs.slice(0, MAX_DIFFS) } : {}) });
    if (index + 1 < vector.steps.length) stopped = { index: index + 1, reason: 'diverged' };
  };
  const noted = (index: number, step: Step, applied: Applied): void => {
    const kind = applied.kind === 'n/a' ? 'n/a' : 'blocked';
    const waived = opts.waivers?.some((w) => w.step === index && (!applied.shimId || w.id === applied.shimId));
    issues.push({ index, op: opLabel(step), kind, message: `the merces backend does not run this call${applied.note ? ` (${applied.note})` : ''}`, ...(applied.shimId ? { shimId: applied.shimId } : {}), ...(waived ? { waived: true } : {}) });
  };
  /** Compare the full snapshots of the named series (all of them when null); the global view when there is none. */
  const compare = (names: string[] | null, fx?: Record<string, number[]>): Diff[] => {
    const all = names ?? ref.seriesNames();
    const out: Diff[] = [];
    for (const name of all.length ? all : [null]) {
      let actual: Record<string, unknown>;
      try {
        actual = mer.snapshot(name, fx);
      } catch (e) {
        out.push({ path: name ?? '(global)', expected: 'a snapshot', actual: e instanceof RunnerError ? e.message : 'no snapshot' });
        continue;
      }
      for (const d of compareExpect(ref.snapshot(name, fx), actual)) out.push(name ? { ...d, path: `${name}.${d.path}` } : d);
    }
    return out;
  };

  try {
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
      executed++;
      const t = BigInt(step.t);
      ref.setTime(t);
      mer.setTime(t);

      if (step.op === 'expect') {
        const diffs = compare(step.series ? [step.series] : [], fxRequestOf(step as unknown as Record<string, unknown>));
        if (diffs.length) {
          diverge(index, step, `the backends disagree at this expect (${diffs.length} field(s))`, diffs);
          break;
        }
        continue;
      }

      if (step.op === 'expect_revert') {
        const r = await checkRevert(ref, step as ExpectRevertStep);
        if (r.result !== 'ok') {
          diverge(index, step, `the reference backend does not revert as the vector says: ${r.result === 'fail' ? r.message : 'skipped'}`);
          break;
        }
        const m = await checkRevert(mer, step as ExpectRevertStep);
        if (m.result === 'skipped') noted(index, step, m.applied);
        else if (m.result === 'fail') {
          diverge(index, step, m.message);
          break;
        }
        continue;
      }

      await ref.apply(call!).catch((e: unknown) => {
        throw new RunnerError(`#${index} ${step.op}: the reference backend reverted ${describeRaised(ref.classify(e))}`);
      });
      let applied: Applied;
      try {
        applied = await mer.apply(call!);
      } catch (e) {
        diverge(index, step, e instanceof RunnerError ? e.message : `the merces backend reverted ${describeRaised(mer.classify(e))}; the reference backend did not`);
        break;
      }
      if (applied.kind === 'blocked' || applied.kind === 'n/a') {
        noted(index, step, applied);
        diverge(index, step, 'the merces backend did not run this action, so the states part here');
        break;
      }
      if (applied.kind === 'shim' && applied.shimId) shims[applied.shimId] = (shims[applied.shimId] ?? 0) + 1;
      if (ref.inFlight().length === 0) {
        const diffs = compare(null);
        if (diffs.length) {
          diverge(index, step, `the backends disagree after this step (${diffs.length} field(s))`, diffs);
          break;
        }
      }
    }
  } catch (e) {
    issues.push({ index: executed - 1, op: 'runner', kind: 'fail', message: e instanceof RunnerError ? e.message : `runner fault: ${describeRaised(mer.classify(e))}` });
  } finally {
    await mer.close();
    await ref.close();
  }
  return {
    id: vector.id,
    vector: vector.name,
    world: `lockstep/${personality}`,
    backend: 'lockstep',
    personality,
    status: statusOf(issues),
    executed,
    total: vector.steps.length,
    ...(stopped ? { stopped } : {}),
    issues,
    shims,
    ms: Date.now() - started,
  };
}

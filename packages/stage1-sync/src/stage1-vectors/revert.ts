import type { ExpectRevertStep } from '@merces/reference';
import { RunnerError, canonicalErrorName, describeRaised } from './errors.ts';
import type { Applied, World } from './world.ts';

/**
 * `expect_revert` (S1 plan §5.2; Stage 1 SIM:488-501, vectors README:117-120).
 *
 * The call must raise a protocol error whose Stage 1 name equals the expected one (pre-v1.1 names map through
 * `ERROR_ALIASES`). The transaction that raised must have left the state and the event log unchanged by the time it
 * raised, before the world restores anything (`Attempt.leaked`: on the merces backend the runner undoes every op that
 * throws, so comparing only afterwards could never see a revert that changed the state). Then the world's
 * serialisation (state, clock, events, runner bookkeeping) must be byte-identical to what it was before the call. A
 * non-protocol exception fails, reported by class only. When the world cannot run the call at all (`blocked` or
 * `n/a`), nothing is checked and the outcome says so. A step of our own may name the error per personality
 * (`expectedRevertError`).
 */
export type RevertOutcome =
  /**
   * `applied`: how the world carried the call out (its shim row, if any; absent when the world gives none);
   * `rolledBack`: transactions of the call that went through before one reverted and that the runner undid (> 0 only
   * for a runner-atomic shim: the revert is atomic by the runner's doing, not parity)
   */
  | { result: 'ok'; applied?: Applied; rolledBack: number }
  /** `diverged`: the call went through or the world is left changed, so the replay cannot go on */
  | { result: 'fail'; message: string; diverged: boolean }
  | { result: 'skipped'; applied: Applied };

/**
 * The error an `expect_revert` expects on `world`: its `error`, or, for a step of our own that names its error per
 * personality (`errorByPersonality`, a case each chain refuses under its own name; merces-only scenarios, `scenarios.ts`),
 * the world's personality's. Stage 1's vectors never carry one.
 */
export function expectedRevertError(world: World, step: ExpectRevertStep): string {
  const per = (step as ExpectRevertStep & { errorByPersonality?: Partial<Record<string, string>> }).errorByPersonality;
  if (per === undefined) return step.error;
  const name = world.personality ? per[world.personality] : undefined;
  if (!name) throw new RunnerError(`expect_revert ${step.call.op} names its error per personality, and ${world.label} has none`);
  return name;
}

export async function checkRevert(world: World, step: ExpectRevertStep): Promise<RevertOutcome> {
  let expected: string;
  try {
    expected = canonicalErrorName(expectedRevertError(world, step));
  } catch (e) {
    if (e instanceof RunnerError) return { result: 'fail', message: e.message, diverged: false };
    throw e;
  }
  const op = step.call.op;
  const before = world.serialize();
  const a = await world.attempt(step.call);
  if (a.ok) {
    if (a.applied.kind === 'blocked' || a.applied.kind === 'n/a') {
      if (world.serialize() !== before) return { result: 'fail', message: `${op} is ${a.applied.kind} on this backend but changed the state`, diverged: true };
      return { result: 'skipped', applied: a.applied };
    }
    return { result: 'fail', message: `expected revert ${expected} for ${op}, but the call succeeded`, diverged: true };
  }
  const restored = world.serialize() === before;
  // the world could not translate the call, or a shim's own check failed: public message, no protocol error
  if (a.error instanceof RunnerError) return { result: 'fail', message: `expected revert ${expected} for ${op}: ${a.error.message}`, diverged: !restored };
  const raised = world.classify(a.error);
  if (!raised.protocol) return { result: 'fail', message: `expected revert ${expected} for ${op}, got a ${describeRaised(raised)}`, diverged: !restored };
  if (canonicalErrorName(raised.name) !== expected) return { result: 'fail', message: `expected revert ${expected} for ${op}, got ${raised.name}`, diverged: !restored };
  // a leak the world then undid is still a failing step, but the replay can go on from the restored state
  if (a.leaked) return { result: 'fail', message: `${op} reverted with ${expected} but changed the state`, diverged: !restored };
  if (!restored) return { result: 'fail', message: `${op} reverted with ${expected} but the world did not restore the state`, diverged: true };
  return { result: 'ok', ...(a.applied ? { applied: a.applied } : {}), rolledBack: a.rolledBack };
}

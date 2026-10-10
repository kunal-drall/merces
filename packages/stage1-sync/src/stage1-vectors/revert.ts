import type { ExpectRevertStep } from '@merces/reference';
import { RunnerError, canonicalErrorName, describeRaised } from './errors.ts';
import type { Applied, World } from './world.ts';

/**
 * `expect_revert` (S1 plan §5.2; Stage 1 SIM:488-501, vectors README:117-120).
 *
 * The call must raise a protocol error whose Stage 1 name equals the expected one (pre-v1.1 names map through
 * `ERROR_ALIASES`), and the world's serialisation (state, clock, events, runner bookkeeping) must be byte-identical
 * afterwards. A non-protocol exception fails, reported by class only. When the world cannot run the call at all
 * (`blocked` or `n/a`), nothing is checked and the outcome says so.
 */
export type RevertOutcome =
  | { result: 'ok' }
  /** `diverged`: the call went through or left the state changed, so the replay cannot go on */
  | { result: 'fail'; message: string; diverged: boolean }
  | { result: 'skipped'; applied: Applied };

export async function checkRevert(world: World, step: ExpectRevertStep): Promise<RevertOutcome> {
  const expected = canonicalErrorName(step.error);
  const op = step.call.op;
  const before = world.serialize();
  let applied: Applied;
  try {
    applied = await world.apply(step.call);
  } catch (e) {
    const changed = world.serialize() !== before;
    // the world could not translate the call, or a shim's own check failed: public message, no protocol error
    if (e instanceof RunnerError) return { result: 'fail', message: `expected revert ${expected} for ${op}: ${e.message}`, diverged: changed };
    const raised = world.classify(e);
    if (!raised.protocol) return { result: 'fail', message: `expected revert ${expected} for ${op}, got a ${describeRaised(raised)}`, diverged: changed };
    if (canonicalErrorName(raised.name) !== expected) return { result: 'fail', message: `expected revert ${expected} for ${op}, got ${raised.name}`, diverged: changed };
    if (changed) return { result: 'fail', message: `${op} reverted with ${expected} but changed the state`, diverged: true };
    return { result: 'ok' };
  }
  if (applied.kind === 'blocked' || applied.kind === 'n/a') {
    if (world.serialize() !== before) return { result: 'fail', message: `${op} is ${applied.kind} on this backend but changed the state`, diverged: true };
    return { result: 'skipped', applied };
  }
  return { result: 'fail', message: `expected revert ${expected} for ${op}, but the call succeeded`, diverged: true };
}

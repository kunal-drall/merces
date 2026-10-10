import type { Step } from '@merces/reference';
import { opLabel } from './load.ts';
import { SHIM_BY_ID } from './shims.ts';
import type { Applied } from './world.ts';

/**
 * What each vector is expected to do on the merces backend once S1 is complete (S1 plan §5.6, amendments: WP6 added to
 * 01 and 11). The reference backend (Stage 1's own simulator) must PASS every vector.
 */

export type ExpectedStatus = 'PASS' | 'PASS-WITH-WAIVERS' | 'NOT-IN-S1';

/**
 * A step the merces backend may not run in S1 (`blocked` or `n/a`), named by its shim-table row. It covers exactly one
 * step of its vector: the step at `step` whose op is `op` (as reports name it: `expect_revert retire_if_capped` is not
 * the action `retire_if_capped`), carried out through the row `id`, of the row's own kind (`waiverFor`).
 */
export interface Waiver {
  step: number;
  op: string;
  id: string;
}

export interface Expected {
  status: ExpectedStatus;
  waivers?: Waiver[];
  /** the S1 work packages a target needs */
  needs?: string[];
  /** NOT-IN-S1: the milestone that brings it, and why */
  milestone?: string;
  reason?: string;
}

/** The ten S1 target vectors. */
export const TARGETS_S1 = ['01', '04', '05', '06', '07', '09', '11', '19', '23', '25'] as const;

export const EXPECTED_S1: Readonly<Record<string, Expected>> = Object.freeze({
  '01': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 32, op: 'expect_revert transfer_units', id: 'NA-1' }, { step: 34, op: 'expect_revert retire_if_capped', id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6'] },
  '02': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'mid-processing expects and process/finalize reverts (multi-step settlement)' },
  '03': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'mid-processing expects and process/finalize reverts; the non-reveal charge on b8 (owner hold, not modelled)' },
  '04': { status: 'PASS', needs: ['WP3', 'WP5'] },
  '05': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 42, op: 'expect_revert retire_if_capped', id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6', 'WP7'] },
  '06': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5', 'WP6'] },
  '07': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5'] },
  '08': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'withdraw_pause_request and end_pause' },
  '09': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6'] },
  '10': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'multi-step transfer windows' },
  '11': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5', 'WP6', 'WP7'] },
  '12': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'income router' },
  '13': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'FX accumulator' },
  '14': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'retire_if_capped as an action' },
  '15': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'mid-processing expects and process/finalize reverts (multi-step settlement)' },
  '16': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'multi-step transfer windows' },
  '17': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'deferred delivery and register_holder' },
  '18': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'income router' },
  '19': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5'] },
  '20': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'tier-3 true-up' },
  '21': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'withdraw_pause_request' },
  '22': { status: 'NOT-IN-S1', milestone: 'S3 + S5', reason: 'register_holder, tail and final claims, multi-step windows' },
  '23': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6', 'WP8'] },
  '24': { status: 'NOT-IN-S1', milestone: 'S5', reason: 'FX accumulator (inverted pair)' },
  '25': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6', 'WP7', 'WP8'] },
});

/** The reference backend replays Stage 1's own simulator: every vector passes. */
export const EXPECTED_REFERENCE: Expected = Object.freeze({ status: 'PASS' });

/** Unknown vectors (a Stage 1 drop with more than 25) are not S1 targets. */
export function expectedS1(id: string): Expected {
  return EXPECTED_S1[id] ?? { status: 'NOT-IN-S1', milestone: '?', reason: 'not in the S1 vector set' };
}

/**
 * The waiver of a vector that covers the step at `index`, which the backend did not run (`applied` is `blocked` or
 * `n/a`). Everything must match: the step index, the step's op, the shim-table row the backend named, and the row
 * must stand for that op and be of the kind the backend reported. An op carried out without a row (the ops outside S1)
 * is never waived, whatever waiver sits at its index.
 */
export function waiverFor(waivers: readonly Waiver[] | undefined, index: number, step: Step, applied: Applied): Waiver | undefined {
  if (!waivers?.length || !applied.shimId) return undefined;
  const op = opLabel(step);
  const callOp = step.op === 'expect_revert' ? step.call.op : step.op;
  const row = SHIM_BY_ID.get(applied.shimId);
  if (!row || row.kind !== applied.kind || !row.ops.includes(callOp)) return undefined;
  return waivers.find((w) => w.step === index && w.op === op && w.id === applied.shimId);
}

/** Text of an expectation for a report cell. */
export function describeExpected(e: Expected): string {
  if (e.status === 'NOT-IN-S1') return `NOT-IN-S1 (${e.milestone ?? '?'}: ${e.reason ?? ''})`;
  if (e.status === 'PASS-WITH-WAIVERS') return `PASS-WITH-WAIVERS (${(e.waivers ?? []).map((w) => `#${w.step} ${w.id}`).join(', ')})`;
  return 'PASS';
}

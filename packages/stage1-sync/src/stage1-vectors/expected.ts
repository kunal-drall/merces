/**
 * What each vector is expected to do on the merces backend once S1 is complete (S1 plan §5.6, amendments: WP6 added to
 * 01 and 11). The reference backend (Stage 1's own simulator) must PASS every vector.
 */

export type ExpectedStatus = 'PASS' | 'PASS-WITH-WAIVERS' | 'NOT-IN-S1';

/** A step the merces backend may not run in S1 (`blocked` or `n/a`), named by its shim-table row. */
export interface Waiver {
  step: number;
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
  '01': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 32, id: 'NA-1' }, { step: 34, id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6'] },
  '02': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'mid-processing expects and process/finalize reverts (multi-step settlement)' },
  '03': { status: 'NOT-IN-S1', milestone: 'S2', reason: 'mid-processing expects and process/finalize reverts; the non-reveal charge on b8 (owner hold, not modelled)' },
  '04': { status: 'PASS', needs: ['WP3', 'WP5'] },
  '05': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 42, id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6', 'WP7'] },
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

/** Text of an expectation for a report cell. */
export function describeExpected(e: Expected): string {
  if (e.status === 'NOT-IN-S1') return `NOT-IN-S1 (${e.milestone ?? '?'}: ${e.reason ?? ''})`;
  if (e.status === 'PASS-WITH-WAIVERS') return `PASS-WITH-WAIVERS (${(e.waivers ?? []).map((w) => `#${w.step} ${w.id}`).join(', ')})`;
  return 'PASS';
}

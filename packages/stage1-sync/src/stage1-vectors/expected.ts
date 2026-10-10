import type { Step } from '@merces/reference';
import type { Diff } from './compare.ts';
import { opLabel } from './load.ts';
import { SHIM_BY_ID } from './shims.ts';
import type { Applied } from './world.ts';

/**
 * What each vector is expected to do on the merces backend after S2 (S1 plan §5.6; S2 plan §3, WP5). The reference
 * backend (Stage 1's own simulator) must PASS every vector.
 *
 * - PASS / PASS-WITH-WAIVERS: a target replays in full; waivers cover blocked or n/a steps only.
 * - PASS-WITH-DIVERGENCES: a target replays in full, and the only differences are the recorded entries of a row of the
 *   divergence register (`divergences.ts`). Another value at a recorded path fails, and so does an entry that no longer
 *   occurs (stale).
 * - PREFIX-PASS: a vector that needs a later milestone is replayed up to its gate (`until`, inclusive), the last step
 *   before the first one the merces backend cannot run yet; every step up to the gate must pass. Gates measured on S2
 *   (the first finding of a full replay is the step after each gate, on both personalities).
 * - NOT-YET: not replayed by default (it never reaches the auction, or stops before it); `milestone` brings it.
 */

export type ExpectedStatus = 'PASS' | 'PASS-WITH-WAIVERS' | 'PASS-WITH-DIVERGENCES' | 'PREFIX-PASS' | 'NOT-YET';

/**
 * A step the merces backend may not run (`blocked` or `n/a`), named by its shim-table row. It covers exactly one step
 * of its vector: the step at `step` whose op is `op` (as reports name it: `expect_revert retire_if_capped` is not the
 * action `retire_if_capped`), carried out through the row `id`, of the row's own kind (`waiverFor`).
 */
export interface Waiver {
  step: number;
  op: string;
  id: string;
}

/**
 * A known divergence at one `expect`: at step `step`, the field `path` (dotted, as `compareExpect` names it) holds
 * Stage 1's value `stage1` in the vector and `ours` on the merces backend. `id` is its register row (`divergences.ts`).
 * Values are the JSON values the comparison sees (decimal strings for amounts).
 */
export interface Divergence {
  id: string;
  step: number;
  path: string;
  stage1: unknown;
  ours: unknown;
}

/**
 * Where lockstep parts because of a known divergence: right after step `divergesAt`, on exactly `diffs` (the full
 * snapshot paths, series-prefixed, with Stage 1's value and ours). Lockstep stops there (the states differ from then
 * on), so the run is PASS-WITH-DIVERGENCES when it parts exactly so, and fails otherwise or when it does not part.
 */
export interface LockstepDivergence {
  id: string;
  divergesAt: number;
  diffs: { path: string; stage1: unknown; ours: unknown }[];
}

export interface Expected {
  status: ExpectedStatus;
  waivers?: Waiver[];
  /** PASS-WITH-DIVERGENCES: the recorded entries (merces backend) */
  divergences?: Divergence[];
  /** PASS-WITH-DIVERGENCES: where lockstep parts (lockstep backend) */
  lockstep?: LockstepDivergence;
  /** PREFIX-PASS: the gate, the last step replayed (inclusive) */
  until?: number;
  /** PREFIX-PASS: the step after the gate, and why the merces backend cannot run it yet */
  next?: string;
  /** the work packages a target needs */
  needs?: string[];
  /** NOT-YET and PREFIX-PASS: the milestone that brings the whole vector, and why */
  milestone?: string;
  reason?: string;
}

/** The ten S1 target vectors. */
export const TARGETS_S1 = ['01', '04', '05', '06', '07', '09', '11', '19', '23', '25'] as const;
/** The four S2 target vectors (multi-step settlement, deferred delivery, register_holder). */
export const TARGETS_S2 = ['02', '03', '15', '17'] as const;
/** Every target vector: replayed in full on the merces backend. */
export const TARGETS: readonly string[] = Object.freeze([...TARGETS_S1, ...TARGETS_S2]);

/**
 * DIV-NRC-1 in vector 03 (S2 plan §3): b8 committed 10,100 USDC and never revealed; Stage 1 charges 1% (101 USDC) at
 * `process_bid b8` (#65), so the fee collector holds 101 USDC more, the auction escrow 101 USDC less until delivery, and
 * b8 gets 101 USDC less back (#75). Values from the vector (Stage 1) and the merces backend under the hold.
 */
const DIV_NRC_1_03: Divergence[] = [
  { id: 'DIV-NRC-1', step: 67, path: 'auction.escrowTotal', stage1: '55925700000', ours: '56026700000' },
  { id: 'DIV-NRC-1', step: 67, path: 'auctionEscrow', stage1: '55925700000', ours: '56026700000' },
  { id: 'DIV-NRC-1', step: 67, path: 'feeCollector', stage1: '428800000', ours: '327800000' },
  { id: 'DIV-NRC-1', step: 77, path: 'balances.b8.stable', stage1: '29899000000', ours: '30000000000' },
  { id: 'DIV-NRC-1', step: 77, path: 'feeCollector', stage1: '428800000', ours: '327800000' },
];

/** Lockstep compares every step of the settlement since S2: 03 parts right after `process_bid b8` (#65). */
const DIV_NRC_1_03_LOCKSTEP: LockstepDivergence = {
  id: 'DIV-NRC-1',
  divergesAt: 65,
  diffs: [
    { path: 'S1.auction.escrowTotal', stage1: '55925700000', ours: '56026700000' },
    { path: 'S1.auctionEscrow', stage1: '55925700000', ours: '56026700000' },
    { path: 'S1.feeCollector', stage1: '428800000', ours: '327800000' },
  ],
};

const S2_RAISE = ['S2 WP2', 'S2 WP4a', 'S2 WP4b'];

export const EXPECTED: Readonly<Record<string, Expected>> = Object.freeze({
  '01': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 32, op: 'expect_revert transfer_units', id: 'NA-1' }, { step: 34, op: 'expect_revert retire_if_capped', id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6'] },
  '02': { status: 'PASS', needs: S2_RAISE },
  '03': { status: 'PASS-WITH-DIVERGENCES', divergences: DIV_NRC_1_03, lockstep: DIV_NRC_1_03_LOCKSTEP, needs: S2_RAISE },
  '04': { status: 'PASS', needs: ['WP3', 'WP5'] },
  '05': { status: 'PASS-WITH-WAIVERS', waivers: [{ step: 42, op: 'expect_revert retire_if_capped', id: 'BLK-1' }], needs: ['WP3', 'WP4', 'WP5', 'WP6', 'WP7'] },
  '06': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5', 'WP6'] },
  '07': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5'] },
  '08': { status: 'PREFIX-PASS', until: 33, next: '#34 `withdraw_pause_request` (no canonical command)', milestone: 'S5', reason: 'withdraw_pause_request and end_pause' },
  '09': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6'] },
  '10': { status: 'PREFIX-PASS', until: 35, next: '#36 `expect_revert open_window` with windows disabled (no canonical windows flag to refuse with)', milestone: 'S5', reason: 'multi-step transfer windows' },
  '11': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5', 'WP6', 'WP7'] },
  '12': { status: 'NOT-YET', milestone: 'S5', reason: 'income router' },
  '13': { status: 'NOT-YET', milestone: 'S5', reason: 'FX accumulator' },
  '14': { status: 'PREFIX-PASS', until: 61, next: '#62 `expect_revert retire_if_capped` (no canonical command)', milestone: 'S5', reason: 'retire_if_capped as an action' },
  '15': { status: 'PASS', needs: S2_RAISE },
  '16': { status: 'PREFIX-PASS', until: 40, next: '#41 `set_flags` (no canonical windows flag)', milestone: 'S5', reason: 'multi-step transfer windows' },
  '17': { status: 'PASS', needs: S2_RAISE },
  '18': { status: 'NOT-YET', milestone: 'S5', reason: 'income router (stops at #11, create_series with a router)' },
  '19': { status: 'PASS', needs: ['WP3', 'WP4', 'WP5'] },
  '20': { status: 'PREFIX-PASS', until: 70, next: '#71 `expect_revert submit_trueup` (no tier-3 true-up)', milestone: 'S5', reason: 'tier-3 true-up' },
  '21': { status: 'PREFIX-PASS', until: 40, next: '#41 `expect_revert approve_pause` with a pause end of 2^64 (the canonical pause end is a safe integer, so it is not AmountOutOfRange), then #42 `withdraw_pause_request`', milestone: 'S5', reason: 'withdraw_pause_request; u64 pause ends' },
  '22': { status: 'PREFIX-PASS', until: 75, next: '#76 `begin_window_settlement` with a price on a live series (one-step windows)', milestone: 'S3 + S5', reason: 'tail and final claims, multi-step windows' },
  '23': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6', 'WP8'] },
  '24': { status: 'NOT-YET', milestone: 'S5', reason: 'FX accumulator (inverted pair)' },
  '25': { status: 'PASS', needs: ['WP3', 'WP5', 'WP6', 'WP7', 'WP8'] },
});

/** The prefix gates: vector id → the last step replayed (inclusive). Iterate them sorted: "10" sorts before "08" as a key. */
export const PREFIX_GATES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(EXPECTED).flatMap(([id, e]) => (e.status === 'PREFIX-PASS' ? [[id, e.until!]] : []))),
);

/** The reference backend replays Stage 1's own simulator: every vector passes. */
export const EXPECTED_REFERENCE: Expected = Object.freeze({ status: 'PASS' });

/** Unknown vectors (a Stage 1 drop with more than 25) are not targets yet. */
export function expectedFor(id: string): Expected {
  return EXPECTED[id] ?? { status: 'NOT-YET', milestone: '?', reason: 'not in the vector set this runner knows' };
}

/**
 * The waiver of a vector that covers the step at `index`, which the backend did not run (`applied` is `blocked` or
 * `n/a`). Everything must match: the step index, the step's op, the shim-table row the backend named, and the row
 * must stand for that op and be of the kind the backend reported. An op carried out without a row (the ops not modelled
 * yet) is never waived, whatever waiver sits at its index.
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
  switch (e.status) {
    case 'NOT-YET':
      return `NOT-YET (${e.milestone ?? '?'}: ${e.reason ?? ''})`;
    case 'PREFIX-PASS':
      return `PREFIX-PASS to #${e.until ?? '?'}, then NOT-YET (${e.milestone ?? '?'}: ${e.reason ?? ''})`;
    case 'PASS-WITH-WAIVERS':
      return `PASS-WITH-WAIVERS (${(e.waivers ?? []).map((w) => `#${w.step} ${w.id}`).join(', ')})`;
    case 'PASS-WITH-DIVERGENCES': {
      const ids = [...new Set((e.divergences ?? []).map((d) => d.id))];
      const steps = [...new Set((e.divergences ?? []).map((d) => d.step))];
      return `PASS-WITH-DIVERGENCES (${ids.join(', ')}: ${(e.divergences ?? []).length} field(s) at ${steps.map((x) => `#${x}`).join(', ')}${e.lockstep ? `; lockstep parts at #${e.lockstep.divergesAt}` : ''})`;
    }
    case 'PASS':
      return 'PASS';
  }
}

/**
 * Split the differences found at the `expect` at `index` against the recorded divergences (`Expected.divergences`):
 * - `accepted`: equal to a recorded entry of this step (path, Stage 1's value, ours);
 * - `failed`: every other difference, including one at a recorded path with another value (`moved` names those);
 * - `stale`: entries of this step whose difference did not occur.
 */
export function splitDivergences(entries: readonly Divergence[] | undefined, index: number, diffs: readonly Diff[]): { accepted: (Diff & { id: string })[]; failed: Diff[]; moved: string[]; stale: Divergence[] } {
  const here = (entries ?? []).filter((d) => d.step === index);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const accepted: (Diff & { id: string })[] = [];
  const failed: Diff[] = [];
  const moved: string[] = [];
  for (const d of diffs) {
    const entry = here.find((e) => e.path === d.path);
    if (entry && same(entry.stage1, d.expected) && same(entry.ours, d.actual)) accepted.push({ ...d, id: entry.id });
    else {
      failed.push(d);
      if (entry) moved.push(d.path);
    }
  }
  const stale = here.filter((e) => !diffs.some((d) => d.path === e.path));
  return { accepted, failed, moved, stale };
}

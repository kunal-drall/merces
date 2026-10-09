/**
 * The Stage 1 vector runner (S1 plan D7, §5): replays Stage 1's parity vectors (`stage1/packages/vectors`, schema 2,
 * SPEC 1.1) on a backend and checks every `expect`, every `expect_revert` and the conservation invariants.
 *
 * Backends:
 * - `reference`: Stage 1's own `Simulator` (`@merces/reference`). It must pass all 25; that proves this runner.
 * - `merces`: our `SimulatorChain`, per personality, through the translators and the shim table (S1 WP9b).
 * - `lockstep`: both, reporting the first field where they diverge (S1 WP9b).
 *
 * Privacy: the runner never persists anything; vectors lose `witness` and `seriesPrivate` at load; reports carry
 * names, indices, error names and public expect values only.
 */
import { RunnerError } from './errors.ts';
import { EXPECTED_REFERENCE, TARGETS_S1, expectedS1, type Expected } from './expected.ts';
import { loadVectors, selects, type LoadedVector } from './load.ts';
import { proofStats, type ProofStats } from './proofs.ts';
import { ReferenceWorld } from './reference-world.ts';
import { replayVector, type VectorRun } from './run.ts';
import { PERSONALITIES, type Backend, type VectorPersonality, type WorldFactory } from './world.ts';

export { TARGETS_S1, EXPECTED_S1, EXPECTED_REFERENCE, expectedS1, describeExpected, type Expected, type ExpectedStatus, type Waiver } from './expected.ts';
export { loadVector, loadVectors, fromJson, listVectorFiles, type LoadedVector } from './load.ts';
export { replayVector, statusOf, type VectorRun, type VectorStatus, type StepIssue, type ReplayOptions } from './run.ts';
export { compareExpect, type Diff } from './compare.ts';
export { checkRevert, type RevertOutcome } from './revert.ts';
export { RunnerError, canonicalErrorName, classifyChainError, type Raised } from './errors.ts';
export { verifyReportCached, proofStats, shutdown, type ProofStats } from './proofs.ts';
export { ReferenceWorld } from './reference-world.ts';
export { SHIMS, SHIM_BY_ID, type Shim } from './shims.ts';
export { renderParity, renderSummary, writeParity, type ParitySource } from './report.ts';
export { PERSONALITIES, type Backend, type World, type WorldFactory, type Applied, type OpKind, type VectorPersonality } from './world.ts';

/** Worlds by backend. The merces backend registers here in S1 WP9b. */
const FACTORIES: Partial<Record<Backend, WorldFactory>> = {
  reference: (v) => ReferenceWorld.create(v),
};

export function backendAvailable(backend: Backend): boolean {
  return FACTORIES[backend] !== undefined;
}

export type BackendChoice = Backend | 'lockstep';

export interface RunOptions {
  /** the vectors directory (Stage 1 `packages/vectors`); not needed when `vectors` is given */
  dir?: string;
  /** already loaded vectors (tests replay mutated copies) */
  vectors?: LoadedVector[];
  /** vector ids ("01") or names; default: every vector on `reference`, the S1 targets on `merces` */
  only?: readonly string[];
  /** default `merces` */
  backend?: BackendChoice;
  /** merces only; default both */
  personalities?: readonly VectorPersonality[];
  /** last step index to replay (inclusive) */
  until?: number;
  /** stop before the first step with this op */
  stopBefore?: string;
}

export interface RunResult extends VectorRun {
  expected: Expected;
  /** the run is at (or better than) its expected status */
  atExpected: boolean;
}

export interface RunReport {
  backend: BackendChoice;
  runs: RunResult[];
  /** vectors not replayed on this backend, with their expectation (the merces backend replays the S1 targets only) */
  notRun: { id: string; vector: string; expected: Expected }[];
  proofs: ProofStats;
  /** every run is at its expected status */
  ok: boolean;
}

/** Is a run at its expected status? A NOT-IN-S1 vector is informational; PASS satisfies PASS-WITH-WAIVERS. */
export function atExpected(run: Pick<VectorRun, 'status'>, expected: Expected): boolean {
  switch (expected.status) {
    case 'NOT-IN-S1':
      return true;
    case 'PASS-WITH-WAIVERS':
      return run.status === 'PASS' || run.status === 'PASS-WITH-WAIVERS';
    case 'PASS':
      return run.status === 'PASS';
  }
}

/** Replay vectors on a backend. Callers that verified proofs `await shutdown()` before exiting. */
export async function runStage1Vectors(opts: RunOptions): Promise<RunReport> {
  const backend = opts.backend ?? 'merces';
  if (backend === 'lockstep') throw new RunnerError('the lockstep backend needs the merces backend, which arrives with S1 WP9b');
  const factory = FACTORIES[backend];
  if (!factory) throw new RunnerError(`the ${backend} backend is not available yet (S1 WP9b)`);
  if (opts.until !== undefined && (!Number.isInteger(opts.until) || opts.until < 0)) throw new RunnerError('until must be a step index (an integer ≥ 0)');

  let vectors: LoadedVector[];
  if (opts.vectors) vectors = opts.only?.length ? opts.vectors.filter((v) => opts.only!.some((o) => selects(o, v))) : opts.vectors;
  else if (opts.dir) vectors = loadVectors(opts.dir, opts.only);
  else throw new RunnerError('no vectors: pass dir or vectors');

  const notRun: RunReport['notRun'] = [];
  if (backend === 'merces' && !opts.only?.length) {
    const targets = new Set<string>(TARGETS_S1);
    for (const v of vectors) if (!targets.has(v.id)) notRun.push({ id: v.id, vector: v.name, expected: expectedS1(v.id) });
    vectors = vectors.filter((v) => targets.has(v.id));
  }

  const worlds: (VectorPersonality | undefined)[] = backend === 'merces' ? [...(opts.personalities?.length ? opts.personalities : PERSONALITIES)] : [undefined];
  const runs: RunResult[] = [];
  for (const v of vectors) {
    const expected = backend === 'reference' ? EXPECTED_REFERENCE : expectedS1(v.id);
    for (const personality of worlds) {
      const world = await factory(v, personality ? { personality } : {});
      try {
        const run = await replayVector(world, v, {
          ...(opts.until !== undefined ? { until: opts.until } : {}),
          ...(opts.stopBefore ? { stopBefore: opts.stopBefore } : {}),
          ...(expected.waivers ? { waivers: expected.waivers } : {}),
        });
        runs.push({ ...run, ...(personality ? { personality } : {}), expected, atExpected: atExpected(run, expected) });
      } finally {
        await world.close();
      }
    }
  }
  return { backend, runs, notRun, proofs: await proofStats(), ok: runs.every((r) => r.atExpected) };
}

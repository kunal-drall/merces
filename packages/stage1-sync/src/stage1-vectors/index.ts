/**
 * The Stage 1 vector runner (S1 plan D7, §5): replays Stage 1's parity vectors (`stage1/packages/vectors`, schema 2,
 * SPEC 1.1) on a backend and checks every `expect`, every `expect_revert` and the conservation invariants.
 *
 * Backends:
 * - `reference`: Stage 1's own `Simulator` (`@merces/reference`). It must pass all 25; that proves this runner.
 * - `merces`: our `SimulatorChain`, per personality, through the translators and the shim table (`merces-world.ts`,
 *   `ops/`, `shims.ts`). By default it replays the targets in full and the prefix-gated vectors up to their gate
 *   (`expected.ts`); known divergences are recorded per step and field (`divergences.ts`).
 * - `lockstep`: both side by side, per personality, stopping at the first step after which they disagree
 *   (`oracle.ts`), over the same vectors and gates.
 *
 * Privacy: the runner never persists anything; vectors lose `witness` and `seriesPrivate` at load; reports carry
 * names, indices, error names and public expect values only.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunnerError } from './errors.ts';
import { EXPECTED_REFERENCE, PREFIX_GATES, TARGETS, expectedFor, type Expected } from './expected.ts';
import { loadVector, loadVectors, selects, type LoadedVector } from './load.ts';
import { proofStats, type ProofStats } from './proofs.ts';
import { MercesWorld } from './merces-world.ts';
import { replayLockstep } from './oracle.ts';
import { ReferenceWorld } from './reference-world.ts';
import { isFinding, replayVector, type VectorRun } from './run.ts';
import { SCENARIO_SETS, loadScenarios, runsOn, scenarioExpected, type Scenario } from './scenarios.ts';
import { PERSONALITIES, type Backend, type VectorPersonality, type WorldFactory } from './world.ts';

export {
  TARGETS,
  TARGETS_S1,
  TARGETS_S2,
  TARGETS_S4,
  PREFIX_GATES,
  EXPECTED,
  EXPECTED_REFERENCE,
  expectedFor,
  describeExpected,
  splitDivergences,
  waiverFor,
  type Divergence,
  type Expected,
  type ExpectedStatus,
  type LockstepDivergence,
  type Waiver,
} from './expected.ts';
export { DIVERGENCES, DIVERGENCE_BY_ID, type DivergenceRow } from './divergences.ts';
export { loadVector, loadVectors, fromJson, listVectorFiles, opLabel, type LoadedVector } from './load.ts';
export { replayVector, statusOf, isFinding, type VectorRun, type VectorStatus, type StepIssue, type RunnerAtomicStep, type ReplayOptions } from './run.ts';
export { compareExpect, type Diff } from './compare.ts';
export { checkRevert, type RevertOutcome } from './revert.ts';
export { RunnerError, canonicalErrorName, classifyChainError, type Raised } from './errors.ts';
export { verifyReportCached, proofStats, shutdown, type ProofStats } from './proofs.ts';
export { ReferenceWorld } from './reference-world.ts';
export { MercesWorld, type MercesWorldOptions, type SyntheticShims } from './merces-world.ts';
export { replayLockstep, type LockstepOptions } from './oracle.ts';
export { TRANSLATORS, NOT_YET, translate } from './ops/index.ts';
export { SHIMS, SHIM_BY_ID, type Shim } from './shims.ts';
export { renderParity, renderSummary, writeParity, type ParitySource } from './report.ts';
export {
  S3_CLAIM_SCENARIOS,
  S4_SIGNATURE_SCENARIOS,
  SCENARIO_SETS,
  SCENARIO_BACKENDS,
  SCENARIO_EXPECTED,
  SCENARIO_EXPECTATIONS,
  scenarioExpected,
  scenarioSetOf,
  runsOn,
  loadScenario,
  loadScenarios,
  renderScenarios,
  type Scenario,
  type ScenarioFile,
  type ScenarioKey,
  type ScenarioSegment,
  type ScenarioSet,
} from './scenarios.ts';
export { PERSONALITIES, type Backend, type World, type WorldFactory, type Applied, type Attempt, type OpKind, type VectorPersonality } from './world.ts';

/** Worlds by backend. */
const FACTORIES: Partial<Record<Backend, WorldFactory>> = {
  reference: (v) => ReferenceWorld.create(v),
  merces: (v, opts) => MercesWorld.create(v, opts),
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
  /**
   * vector ids ("01") or names; default: every vector on `reference`; on `merces` and `lockstep` the targets and the
   * prefix-gated vectors (to their gate), or every vector of `vectors` when they are given
   */
  only?: readonly string[];
  /** default `merces` */
  backend?: BackendChoice;
  /** merces and lockstep only; default both */
  personalities?: readonly VectorPersonality[];
  /** last step index to replay (inclusive); replaces a prefix gate's own */
  until?: number;
  /** stop before the first step with this op */
  stopBefore?: string;
  /**
   * the expectation of every vector replayed, in place of its own (`expectedFor`, or PASS on the reference backend), or
   * a function giving each its own: our scenarios (`scenarios.ts`) are no Stage 1 vector and must PASS on every backend,
   * unless `SCENARIO_EXPECTATIONS` records a Stage 1-internal difference resolved toward both chains
   */
  expected?: Expected | ((v: LoadedVector) => Expected);
}

export interface RunResult extends VectorRun {
  expected: Expected;
  /** the run is at (or better than) its expected status */
  atExpected: boolean;
}

export interface RunReport {
  backend: BackendChoice;
  runs: RunResult[];
  /** vectors not replayed on this backend, with their expectation (merces and lockstep leave the NOT-YET ones out by default) */
  notRun: { id: string; vector: string; expected: Expected }[];
  proofs: ProofStats;
  /** every run is at its expected status */
  ok: boolean;
}

/**
 * Is a run at its expected status?
 * - PASS: PASS only. PASS-WITH-WAIVERS: PASS or PASS-WITH-WAIVERS.
 * - PASS-WITH-DIVERGENCES: no finding; the recorded divergences are accepted where the run reached them (a partial
 *   run that stops before them is PASS). A moved or stale entry is a failure, so the run is FAIL.
 * - PREFIX-PASS: no finding at or before the gate (a replay past the gate, with `until`, is judged on the prefix).
 * - NOT-YET: informational.
 */
export function atExpected(run: Pick<VectorRun, 'status' | 'issues'>, expected: Expected): boolean {
  switch (expected.status) {
    case 'NOT-YET':
      return true;
    case 'PREFIX-PASS':
      return !run.issues.some((i) => i.index <= (expected.until ?? Infinity) && isFinding(i));
    case 'PASS-WITH-DIVERGENCES':
      return run.status === 'PASS' || run.status === 'PASS-WITH-WAIVERS' || run.status === 'PASS-WITH-DIVERGENCES';
    case 'PASS-WITH-WAIVERS':
      return run.status === 'PASS' || run.status === 'PASS-WITH-WAIVERS';
    case 'PASS':
      return run.status === 'PASS';
  }
}

/** Replay vectors on a backend. Callers that verified proofs `await shutdown()` before exiting. */
export async function runStage1Vectors(opts: RunOptions): Promise<RunReport> {
  const backend = opts.backend ?? 'merces';
  const factory = backend === 'lockstep' ? undefined : FACTORIES[backend];
  if (backend !== 'lockstep' && !factory) throw new RunnerError(`the ${backend} backend is not available`);
  if (opts.until !== undefined && (!Number.isInteger(opts.until) || opts.until < 0)) throw new RunnerError('until must be a step index (an integer ≥ 0)');

  let vectors: LoadedVector[];
  if (opts.vectors) vectors = opts.only?.length ? opts.vectors.filter((v) => opts.only!.some((o) => selects(o, v))) : opts.vectors;
  else if (opts.dir) vectors = loadVectors(opts.dir, opts.only);
  else throw new RunnerError('no vectors: pass dir or vectors');

  const notRun: RunReport['notRun'] = [];
  if (backend !== 'reference' && !opts.only?.length && !opts.vectors) {
    const replayed = new Set<string>([...TARGETS, ...Object.keys(PREFIX_GATES)]);
    for (const v of vectors) if (!replayed.has(v.id)) notRun.push({ id: v.id, vector: v.name, expected: expectedFor(v.id) });
    vectors = vectors.filter((v) => replayed.has(v.id));
  }

  const worlds: (VectorPersonality | undefined)[] = backend === 'reference' ? [undefined] : [...(opts.personalities?.length ? opts.personalities : PERSONALITIES)];
  const runs: RunResult[] = [];
  for (const v of vectors) {
    const expected = typeof opts.expected === 'function' ? opts.expected(v) : (opts.expected ?? (backend === 'reference' ? EXPECTED_REFERENCE : expectedFor(v.id)));
    // a prefix gate replays to its gate unless the caller names its own last step
    const until = opts.until ?? expected.until;
    const replay = {
      ...(until !== undefined ? { until } : {}),
      ...(opts.stopBefore ? { stopBefore: opts.stopBefore } : {}),
      ...(expected.waivers ? { waivers: expected.waivers } : {}),
    };
    for (const personality of worlds) {
      if (backend === 'lockstep') {
        const run = await replayLockstep(v, personality!, { ...replay, ...(expected.lockstep ? { lockstep: expected.lockstep } : {}) });
        runs.push({ ...run, expected, atExpected: atExpected(run, expected) });
        continue;
      }
      const world = await factory!(v, personality ? { personality } : {});
      try {
        const run = await replayVector(world, v, { ...replay, ...(expected.divergences ? { divergences: expected.divergences } : {}) });
        runs.push({ ...run, ...(personality ? { personality } : {}), expected, atExpected: atExpected(run, expected) });
      } finally {
        await world.close();
      }
    }
  }
  return { backend, runs, notRun, proofs: await proofStats(), ok: runs.every((r) => r.atExpected) };
}

/** A vector given by path is no Stage 1 vector with a recorded gate or divergence: it must PASS in full on every backend. */
export const EXPECTED_FILE: Expected = Object.freeze({ status: 'PASS' });

export interface VectorFileOptions {
  /** default `merces` */
  backend?: BackendChoice;
  /** merces and lockstep only; default both */
  personalities?: readonly VectorPersonality[];
  /** last step index to replay (inclusive) */
  until?: number;
  /** stop before the first step with this op */
  stopBefore?: string;
}

/**
 * Replay vector files given by path (Stage 1's format, `schema 2`, outside the Stage 1 directory): the vectors we
 * propose to Stage 1 (`docs/stage1/defects/vectors`, e.g. 26, the final share of an open ask's units, DIV-S1I-1). Each
 * is expected to PASS in full (`EXPECTED_FILE`) on the chosen backend: on the merces backend that shows our engine does
 * what the vector says (both chains' values); on the reference backend a vector that carries a Stage 1-internal
 * difference fails exactly where Stage 1's simulator disagrees with its chains. A missing file is a `RunnerError`.
 */
export async function runVectorFiles(files: readonly string[], opts: VectorFileOptions = {}): Promise<RunReport> {
  if (!files.length) throw new RunnerError('no vector files given');
  const vectors = files.map((f) => {
    const file = resolve(f);
    if (!existsSync(file)) throw new RunnerError(`no vector file ${f}`);
    return loadVector(file);
  });
  return runStage1Vectors({
    vectors,
    backend: opts.backend ?? 'merces',
    expected: EXPECTED_FILE,
    ...(opts.personalities ? { personalities: opts.personalities } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    ...(opts.stopBefore ? { stopBefore: opts.stopBefore } : {}),
  });
}

export interface ScenarioRunOptions {
  /** the Stage 1 vectors directory the scenarios' base vectors come from */
  vectorsDir: string;
  /** a scenarios directory, or several; default every set (`SCENARIO_SETS`: the S3 claim and S4 signature scenarios) */
  dir?: string | readonly string[];
  /** scenario ids ("S3a") or names; default all */
  only?: readonly string[];
  /** default `lockstep` */
  backend?: BackendChoice;
  /** merces and lockstep only; default both */
  personalities?: readonly VectorPersonality[];
}

/**
 * Replay our scenarios (`scenarios.ts`) on a backend; each must PASS, or be at its `SCENARIO_EXPECTATIONS` entry on the
 * merces and lockstep backends (a Stage 1-internal difference resolved toward both chains). A scenario that does not
 * run on the backend (`backends`, e.g. a merces-only one on the reference or in lockstep) is left out of the report and
 * listed in `skipped`. Returns every scenario loaded with the report.
 */
export async function runScenarios(opts: ScenarioRunOptions): Promise<{ scenarios: Scenario[]; report: RunReport; skipped: Scenario[] }> {
  const scenarios = loadScenarios(opts.dir ?? SCENARIO_SETS.map((x) => x.dir), opts.vectorsDir, opts.only);
  const backend = opts.backend ?? 'lockstep';
  const run = scenarios.filter((s) => runsOn(s, backend));
  const report = await runStage1Vectors({
    vectors: run.map((s) => s.vector),
    backend,
    expected: (v) => scenarioExpected(v.id, backend),
    ...(opts.personalities ? { personalities: opts.personalities } : {}),
  });
  return { scenarios, report, skipped: scenarios.filter((s) => !runsOn(s, backend)) };
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeExpected, type Expected } from './expected.ts';
import { RunnerError } from './errors.ts';
import type { RunReport, RunResult } from './index.ts';
import { fromJson, type LoadedVector } from './load.ts';
import { isFinding } from './run.ts';

/**
 * Our own scenarios (S3 plan WP2, amendment M5): the paths of Stage 1's claim family that no Stage 1 vector takes,
 * written in Stage 1's op format and replayed by this runner like a vector, in lockstep against Stage 1's own simulator.
 *
 * A scenario file names a Stage 1 vector (`base`) and lists `segments` in order: a range of the base vector's steps
 * (`baseSteps: [from, to]`, inclusive, copied as they are, report proofs included) or steps of our own (`steps`). So a
 * scenario reuses a vector's bootstrap, raise, reports and payments up to the point it needs, adds its own calls
 * there, and may go on with later steps of the vector. The `expect` steps of our own carry Stage 1's values: the
 * reference backend (Stage 1's simulator) must pass them, and lockstep compares the full snapshots of both backends
 * after every step anyway.
 *
 * A scenario is ours, not Stage 1's: passing shows the merces backend does what Stage 1's simulator does on these
 * paths. It is no Stage 1 vector, so every backend must PASS it (`SCENARIO_EXPECTED`), and it is reported apart from
 * the vectors (`renderScenarios`, the "S3 claim scenarios" section of VECTOR_PARITY.md).
 *
 * Privacy: the composed vector goes through `fromJson`, so the base vector's `witness` and `seriesPrivate` are dropped
 * and its keys stay non-enumerable, as for a vector.
 */

/** The S3 claim scenarios (S3 plan WP2 (a)-(g), amendment M5). */
export const S3_CLAIM_SCENARIOS = fileURLToPath(new URL('../../test/fixtures/s3-claims', import.meta.url));

/** A scenario must PASS on every backend: no waiver, no divergence, no gate. */
export const SCENARIO_EXPECTED: Expected = Object.freeze({ status: 'PASS' });

export type ScenarioSegment = { baseSteps: [number, number] } | { steps: Record<string, unknown>[] };

/** A scenario file as written (`test/fixtures/s3-claims/*.json`). */
export interface ScenarioFile {
  /** `<id>_<words>`, e.g. `S3a_tail_before_redeem`; the id names it in reports */
  name: string;
  description: string;
  /** the cases of the S3 plan's WP2 list it covers, e.g. ["a"] */
  covers: string[];
  /** the Stage 1 vector whose steps it reuses, e.g. `09_tail_clause` */
  base: string;
  segments: ScenarioSegment[];
}

/** A loaded scenario: the composed vector, ready to replay, and where its steps come from. */
export interface Scenario {
  vector: LoadedVector;
  base: string;
  covers: string[];
  /** where each part of the composed vector comes from, e.g. "09 #0-#63 as #0-#63", "ours as #64-#65" */
  parts: string[];
  /** steps of our own */
  own: number;
}

const NAME = /^([A-Za-z0-9]+)_[a-z0-9_]+$/;

/**
 * Compose and check one scenario file against the Stage 1 vectors in `vectorsDir`. Throws a `RunnerError` (public facts
 * only) when the file is not a scenario this runner reads: an unknown base vector, a step range outside it, steps out
 * of time order, or a composed vector `fromJson` refuses.
 */
export function loadScenario(file: string, vectorsDir: string): Scenario {
  const label = basename(file);
  let f: ScenarioFile;
  try {
    f = JSON.parse(readFileSync(file, 'utf8')) as ScenarioFile;
  } catch {
    throw new RunnerError(`${label}: not a JSON file`);
  }
  const m = typeof f.name === 'string' ? NAME.exec(f.name) : null;
  if (!m) throw new RunnerError(`${label}: name must be <id>_<words>`);
  if (typeof f.description !== 'string' || !f.description) throw new RunnerError(`${f.name}: no description`);
  if (!Array.isArray(f.covers) || !f.covers.every((c) => typeof c === 'string')) throw new RunnerError(`${f.name}: covers must list the cases it covers`);
  if (typeof f.base !== 'string' || !/^\d\d_[a-z0-9_]+$/.test(f.base)) throw new RunnerError(`${f.name}: base must name a Stage 1 vector`);
  const baseFile = join(vectorsDir, `${f.base}.json`);
  if (!existsSync(baseFile)) throw new RunnerError(`${f.name}: no Stage 1 vector ${f.base}`);
  const base = JSON.parse(readFileSync(baseFile, 'utf8')) as Record<string, unknown> & { steps: Record<string, unknown>[] };
  if (!Array.isArray(f.segments) || f.segments.length === 0) throw new RunnerError(`${f.name}: no segments`);

  const steps: Record<string, unknown>[] = [];
  const parts: string[] = [];
  let own = 0;
  let lastBase = -1;
  const span = (from: number) => (steps.length - 1 > from ? `#${from}-#${steps.length - 1}` : `#${from}`);
  for (const [k, seg] of f.segments.entries()) {
    const from = steps.length;
    if ('baseSteps' in seg) {
      const [a, b] = seg.baseSteps;
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b >= base.steps.length) throw new RunnerError(`${f.name}: segment ${k} names steps outside ${f.base} (0-${base.steps.length - 1})`);
      if (a <= lastBase) throw new RunnerError(`${f.name}: segment ${k} repeats or reorders steps of ${f.base}`);
      lastBase = b;
      steps.push(...structuredClone(base.steps.slice(a, b + 1)));
      parts.push(`${f.base.slice(0, 2)} ${a === b ? `#${a}` : `#${a}-#${b}`} as ${span(from)}`);
    } else if (Array.isArray(seg.steps) && seg.steps.length > 0) {
      for (const s of seg.steps) {
        const call = (s.op === 'expect_revert' ? s.call : s) as Record<string, unknown> | undefined;
        if (call && 'witness' in call) throw new RunnerError(`${f.name}: a step of our own carries a witness`);
      }
      steps.push(...structuredClone(seg.steps));
      own += seg.steps.length;
      parts.push(`ours as ${span(from)}`);
    } else throw new RunnerError(`${f.name}: segment ${k} is neither baseSteps nor steps`);
  }
  for (let i = 1; i < steps.length; i++) {
    if (typeof steps[i]!.t === 'string' && typeof steps[i - 1]!.t === 'string' && BigInt(steps[i]!.t as string) < BigInt(steps[i - 1]!.t as string)) {
      throw new RunnerError(`${f.name}: step #${i} goes back in time`);
    }
  }
  const vector = fromJson({ ...base, description: f.description, steps }, f.base, file);
  vector.id = m[1]!;
  vector.name = f.name;
  return { vector, base: f.base, covers: f.covers, parts, own };
}

/** The scenarios of `dir` (`*.json`, by name), optionally only those `only` names (ids such as "S3a" or full names). */
export function loadScenarios(dir: string, vectorsDir: string, only?: readonly string[]): Scenario[] {
  if (!existsSync(dir)) throw new RunnerError(`no scenarios directory ${basename(dir)}`);
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => loadScenario(join(dir, f), vectorsDir));
  if (!all.length) throw new RunnerError(`no scenarios in ${basename(dir)}`);
  const ids = new Set<string>();
  for (const s of all) {
    if (ids.has(s.vector.id)) throw new RunnerError(`two scenarios share the id ${s.vector.id}`);
    ids.add(s.vector.id);
  }
  if (!only?.length) return all;
  const unknown = only.filter((o) => !all.some((s) => s.vector.id === o || s.vector.name === o));
  if (unknown.length) throw new RunnerError(`no scenario matches ${unknown.join(', ')}`);
  return all.filter((s) => only.some((o) => s.vector.id === o || s.vector.name === o));
}

function cell(r: RunResult | undefined): string {
  if (!r) return '—';
  const failures = r.issues.filter((i) => i.kind === 'fail').length;
  return `${r.status}${failures ? ` (${failures} failing step${failures > 1 ? 's' : ''})` : ''} ${r.executed}/${r.total}`;
}

/**
 * The "S3 claim scenarios" section of VECTOR_PARITY.md: one row per scenario with its result on every world of
 * `reports`, where its steps come from, and the findings of any run that is not a PASS. Public values only.
 */
export function renderScenarios(scenarios: readonly Scenario[], reports: readonly RunReport[]): string[] {
  const runs = reports.flatMap((r) => r.runs);
  const worlds = [...new Set(runs.map((r) => r.world))];
  const lines: string[] = [
    "## S3 claim scenarios (ours, lockstep against Stage 1's Simulator)",
    '',
    "The paths of Stage 1's claim family that no Stage 1 vector takes (S3 plan WP2, amendment M5), written in Stage 1's op format (`packages/stage1-sync/test/fixtures/s3-claims`, `pnpm stage1:vectors --scenarios`). Each reuses steps of a Stage 1 vector (its bootstrap, raise, reports with their proofs and payments) and adds calls of our own; its own `expect`s carry Stage 1's values, which the reference backend (Stage 1's simulator) passes, and lockstep compares the full snapshots of both backends after every step. They are ours, not Stage 1's vectors: every backend must PASS them, with no waiver and no divergence.",
    '',
    `| Scenario | Covers | Built from | ${worlds.join(' | ')} |`,
    `| --- | --- | --- | ${worlds.map(() => '---').join(' | ')} |`,
  ];
  for (const s of scenarios) {
    const row = worlds.map((w) => cell(runs.find((r) => r.vector === s.vector.name && r.world === w)));
    lines.push(`| ${s.vector.name} | ${s.covers.map((c) => `(${c})`).join(' ')} | ${s.parts.join('; ')} | ${row.join(' | ')} |`);
  }
  lines.push('');
  for (const s of scenarios) lines.push(`- ${s.vector.name}: ${s.vector.description}`);
  const bad = runs.filter((r) => !r.atExpected || r.issues.some(isFinding));
  if (bad.length) {
    lines.push('', '### Scenario findings', '');
    for (const r of bad) {
      lines.push(`- ${r.vector} on ${r.world}: ${r.status}, expected ${describeExpected(r.expected)}`);
      for (const i of r.issues.filter(isFinding)) lines.push(`  - #${i.index} \`${i.op}\`: ${i.message}`);
    }
  }
  return lines;
}

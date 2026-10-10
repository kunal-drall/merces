import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressFromPrivateKey, toChecksumAddress } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { describeExpected, type Expected } from './expected.ts';
import { RunnerError } from './errors.ts';
import type { BackendChoice, RunReport, RunResult } from './index.ts';
import { fromJson, type LoadedVector } from './load.ts';
import { isFinding } from './run.ts';
import { PERSONALITIES, type VectorPersonality } from './world.ts';

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
 * paths. It is no Stage 1 vector, so every backend must PASS it (`SCENARIO_EXPECTED`), with one exception: a scenario
 * that shows a Stage 1-internal difference resolved toward both chains (Stage 1's TS reference and its EVM and Solana
 * programs disagree, and we follow the programs) is PASS-WITH-DIVERGENCES on the merces and lockstep backends, on the
 * entries of its row of the divergence register (`SCENARIO_EXPECTATIONS`, `divergences.ts`), and still PASS on the
 * reference backend, whose values its expects carry. Scenarios are reported apart from the vectors (`renderScenarios`,
 * the "S3 claim scenarios" section of VECTOR_PARITY.md).
 *
 * Two sets (`SCENARIO_SETS`): S3's claim scenarios and S4's signature scenarios, each reported in its own section.
 *
 * - A scenario may run on fewer backends (`backends`): one that shows a rule Stage 1's reference does not model at all
 *   runs on the merces backend only, because the reference (and so lockstep, which needs both sides to succeed) has
 *   nothing to compare it with. S4d is one (the last-key rule, DIV-S1I-2; S4 amendment fix 1).
 * - An `expect_revert` of our own may name its error per personality (`errorByPersonality: {solana, monad}`), for a case
 *   each chain refuses under its own name (S4 D9); its `error` repeats the solana name (the vector format needs one).
 *   Only a merces-only scenario may carry one: the reference has no personality.
 * - A scenario may carry keys of its own (`keys`, beside the base vector's), each a published test key with seed
 *   `<scenario id>:<name>`: the loader checks the private key is Stage 1's `deriveTestPrivateKey(seed)` and the address
 *   its own, and refuses a name the base vector already has.
 *
 * Privacy: the composed vector goes through `fromJson`, so the base vector's `witness` and `seriesPrivate` are dropped
 * and its keys (the scenario's own included) stay non-enumerable, as for a vector.
 */

/** The S3 claim scenarios (S3 plan WP2 (a)-(g), amendment M5). */
export const S3_CLAIM_SCENARIOS = fileURLToPath(new URL('../../test/fixtures/s3-claims', import.meta.url));

/** The S4 signature scenarios (S4 plan §4: the key registry, grace and rotation; S4d in WP5). */
export const S4_SIGNATURE_SCENARIOS = fileURLToPath(new URL('../../test/fixtures/s4-signatures', import.meta.url));

/** A set of our scenarios: its directory, the id prefix of its scenarios, and its section of VECTOR_PARITY.md. */
export interface ScenarioSet {
  id: 'S3' | 'S4';
  dir: string;
  title: string;
  intro: string;
}

export const SCENARIO_SETS: readonly ScenarioSet[] = Object.freeze([
  {
    id: 'S3',
    dir: S3_CLAIM_SCENARIOS,
    title: "S3 claim scenarios (ours, lockstep against Stage 1's Simulator)",
    intro:
      "The paths of Stage 1's claim family that no Stage 1 vector takes (S3 plan WP2, amendment M5), written in Stage 1's op format (`packages/stage1-sync/test/fixtures/s3-claims`, `pnpm stage1:vectors --scenarios`). Each reuses steps of a Stage 1 vector (its bootstrap, raise, reports with their proofs and payments) and adds calls of our own; its own `expect`s carry Stage 1's values, which the reference backend (Stage 1's simulator) passes, and lockstep compares the full snapshots of both backends after every step. They are ours, not Stage 1's vectors: every backend must PASS them, with no waiver and no divergence, except where a scenario shows a Stage 1-internal difference resolved toward both chains (Stage 1's simulator and its EVM and Solana programs disagree, and we follow the programs): it is PASS-WITH-DIVERGENCES on the merces and lockstep backends, on exactly the entries of its row of the divergence register (see \"Known divergences\" above).",
  },
  {
    id: 'S4',
    dir: S4_SIGNATURE_SCENARIOS,
    title: 'S4 signature scenarios (ours)',
    intro:
      "Stage 1's key registry and signatures on paths no Stage 1 vector takes (S4 plan §4), written in Stage 1's op format (`packages/stage1-sync/test/fixtures/s4-signatures`, `pnpm stage1:vectors --scenarios`). Where Stage 1's reference models the rule (a key's revocation grace), a scenario runs on the reference, the merces backend and in lockstep, like the S3 scenarios. Where only Stage 1's chains do (the last-key rule: Stage 1's reference revokes the last key, both chains refuse it, DIV-S1I-2), the scenario runs on the merces backend only, its `expect_revert` naming each personality's own error (Solana `LastKeyOfKind`, EVM `LastActiveKey`), and the reference and lockstep columns read \"not run\".",
  },
]);

/** A scenario must PASS on every backend: no waiver, no divergence, no gate (but see `SCENARIO_EXPECTATIONS`). */
export const SCENARIO_EXPECTED: Expected = Object.freeze({ status: 'PASS' });

/**
 * The scenarios that are not PASS on the merces and lockstep backends, by id: each shows a Stage 1-internal difference
 * resolved toward both chains, a row of the divergence register (`divergences.ts`). Its expects carry Stage 1's
 * simulator's values (the reference backend PASSes them); the merces backend differs on exactly the recorded fields, and
 * the backends part in lockstep right after the recorded step on exactly the recorded fields. A difference anywhere else,
 * or a recorded one that no longer occurs, fails as for a vector.
 */
export const SCENARIO_EXPECTATIONS: Readonly<Record<string, Expected>> = Object.freeze({
  // DIV-S1I-1 (S3 review): b1's first claim_final (#78) is weighed on its 60 redeemed units plus the 40 in its open ask's
  // escrow, as both chains weigh it (2,625 USDC at 26.25 a unit), not on the 60 (1,575 USDC) as Stage 1's simulator
  // does; so b1 is paid 1,050 USDC more and the vault, which Stage 1's simulator leaves at 1,050 USDC once every unit
  // is claimed (#87), ends at 0
  S3l: {
    status: 'PASS-WITH-DIVERGENCES',
    divergences: [
      { id: 'DIV-S1I-1', step: 79, path: 'balances.b1.stable', stage1: '69260161480', ours: '70310161480' },
      { id: 'DIV-S1I-1', step: 79, path: 'vault', stage1: '54517581720', ours: '53467581720' },
      { id: 'DIV-S1I-1', step: 87, path: 'balances.b1.stable', stage1: '73986935800', ours: '75036935800' },
      { id: 'DIV-S1I-1', step: 87, path: 'vault', stage1: '1050000000', ours: '0' },
    ],
    lockstep: {
      id: 'DIV-S1I-1',
      divergesAt: 78,
      // a wallet's stablecoin balance is in every series' snapshot: S1's too
      diffs: [
        { path: 'S1.balances.b1.stable', stage1: '69260161480', ours: '70310161480' },
        { path: 'S2.balances.b1.stable', stage1: '69260161480', ours: '70310161480' },
        { path: 'S2.vault', stage1: '54517581720', ours: '53467581720' },
      ],
    },
  },
});

/** A scenario's expectation on a backend: PASS on the reference backend, else its `SCENARIO_EXPECTATIONS` entry or PASS. */
export function scenarioExpected(id: string, backend: BackendChoice): Expected {
  return backend === 'reference' ? SCENARIO_EXPECTED : (SCENARIO_EXPECTATIONS[id] ?? SCENARIO_EXPECTED);
}

export type ScenarioSegment = { baseSteps: [number, number] } | { steps: Record<string, unknown>[] };

/** The backends a scenario may run on. */
export const SCENARIO_BACKENDS: readonly BackendChoice[] = Object.freeze(['reference', 'merces', 'lockstep']);

/** A published test key of a scenario's own (Stage 1's vector `keys` format). */
export interface ScenarioKey {
  /** `<scenario id>:<name>` */
  seed: string;
  privateKey: string;
  address: string;
}

/** A scenario file as written (`test/fixtures/s3-claims/*.json`, `test/fixtures/s4-signatures/*.json`). */
export interface ScenarioFile {
  /** `<id>_<words>`, e.g. `S3a_tail_before_redeem`; the id names it in reports */
  name: string;
  description: string;
  /** the cases of its milestone's plan it covers, e.g. ["a"] */
  covers: string[];
  /** the Stage 1 vector whose steps it reuses, e.g. `09_tail_clause` */
  base: string;
  /** the backends it runs on (default all three); a rule Stage 1's reference does not model runs on `merces` only */
  backends?: BackendChoice[];
  /** test keys of its own, beside the base vector's */
  keys?: Record<string, ScenarioKey>;
  segments: ScenarioSegment[];
}

/** A loaded scenario: the composed vector, ready to replay, and where its steps come from. */
export interface Scenario {
  vector: LoadedVector;
  base: string;
  covers: string[];
  /** the backends it runs on */
  backends: readonly BackendChoice[];
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
  const backends = f.backends ?? SCENARIO_BACKENDS;
  if (!Array.isArray(backends) || backends.length === 0 || !backends.every((b) => SCENARIO_BACKENDS.includes(b)) || new Set(backends).size !== backends.length) {
    throw new RunnerError(`${f.name}: backends must list some of ${SCENARIO_BACKENDS.join(', ')}`);
  }
  const mercesOnly = backends.length === 1 && backends[0] === 'merces';
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
        if ('errorByPersonality' in s) checkErrorByPersonality(f.name, s, mercesOnly);
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
  const keys = { ...((base.keys as Record<string, unknown> | undefined) ?? {}), ...scenarioKeys(f, m[1]!, base) };
  const vector = fromJson({ ...base, description: f.description, steps, keys }, f.base, file);
  vector.id = m[1]!;
  vector.name = f.name;
  return { vector, base: f.base, covers: f.covers, backends: [...backends], parts, own };
}

/** An `expect_revert` of our own that names its error per personality: merces-only, both personalities, `error` the solana name. */
function checkErrorByPersonality(name: string, step: Record<string, unknown>, mercesOnly: boolean): void {
  const per = step.errorByPersonality as Record<string, unknown> | null | undefined;
  if (step.op !== 'expect_revert') throw new RunnerError(`${name}: only an expect_revert may name its error per personality`);
  if (!mercesOnly) throw new RunnerError(`${name}: an error per personality needs a scenario run on the merces backend only (the reference has no personality)`);
  const keys = per && typeof per === 'object' ? Object.keys(per).sort() : [];
  if (keys.join(',') !== [...PERSONALITIES].sort().join(',') || !keys.every((k) => typeof per![k] === 'string' && per![k])) {
    throw new RunnerError(`${name}: errorByPersonality must name the error on ${PERSONALITIES.join(' and ')}`);
  }
  if (step.error !== per!.solana) throw new RunnerError(`${name}: an expect_revert with errors per personality repeats the solana name as its error`);
}

/**
 * A scenario's own keys, checked: each a published Stage 1 test key, `privateKey = deriveTestPrivateKey("<id>:<name>")`
 * and `address` its own (lowercase or EIP-55), under a name the base vector does not use. Nothing is printed.
 */
function scenarioKeys(f: ScenarioFile, id: string, base: Record<string, unknown>): Record<string, ScenarioKey> {
  if (f.keys === undefined) return {};
  if (!f.keys || typeof f.keys !== 'object' || Array.isArray(f.keys)) throw new RunnerError(`${f.name}: keys must map names to keys`);
  const baseKeys = (base.keys as Record<string, unknown> | undefined) ?? {};
  const out: Record<string, ScenarioKey> = {};
  for (const [name, k] of Object.entries(f.keys)) {
    if (name in baseKeys) throw new RunnerError(`${f.name}: key ${name} is already a key of ${f.base}`);
    const seed = `${id}:${name}`;
    if (!k || k.seed !== seed) throw new RunnerError(`${f.name}: key ${name} must have the seed ${seed}`);
    const expected = '0x' + Buffer.from(deriveTestPrivateKey(seed)).toString('hex');
    if (typeof k.privateKey !== 'string' || k.privateKey.toLowerCase() !== expected) throw new RunnerError(`${f.name}: key ${name} is not Stage 1's test key for its seed`);
    if (typeof k.address !== 'string' || k.address.toLowerCase() !== toChecksumAddress(addressFromPrivateKey(expected)).toLowerCase()) {
      throw new RunnerError(`${f.name}: key ${name}'s address is not its private key's`);
    }
    out[name] = { seed, privateKey: k.privateKey, address: k.address };
  }
  return out;
}

/**
 * The scenarios of `dir` (`*.json`, by name), or of several directories in order (every set, `SCENARIO_SETS`, by
 * default), optionally only those `only` names (ids such as "S3a" or full names). Ids are unique across directories.
 */
export function loadScenarios(dir: string | readonly string[] = SCENARIO_SETS.map((x) => x.dir), vectorsDir: string, only?: readonly string[]): Scenario[] {
  const dirs = typeof dir === 'string' ? [dir] : dir;
  const all: Scenario[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) throw new RunnerError(`no scenarios directory ${basename(d)}`);
    const here = readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => loadScenario(join(d, f), vectorsDir));
    if (!here.length) throw new RunnerError(`no scenarios in ${basename(d)}`);
    all.push(...here);
  }
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

/** Does `s` run on `backend`? (A scenario lists its backends; most run on all three.) */
export function runsOn(s: Pick<Scenario, 'backends'>, backend: BackendChoice): boolean {
  return s.backends.includes(backend);
}

/** The set a scenario belongs to, by its id's prefix (`S3…`, `S4…`). */
export function scenarioSetOf(s: Scenario): ScenarioSet | undefined {
  return SCENARIO_SETS.find((x) => s.vector.id.startsWith(x.id));
}

function cell(r: RunResult | undefined): string {
  if (!r) return '—';
  const failures = r.issues.filter((i) => i.kind === 'fail').length;
  const accepted = r.issues.filter((i) => i.kind === 'divergence');
  const fields = accepted.reduce((n, i) => n + (i.diffs?.length ?? 0), 0);
  // lockstep stops where the backends part, so a recorded parting is named where it happened
  const known = !accepted.length ? '' : r.backend === 'lockstep' ? `, diverged at #${accepted[0]!.index} as recorded (${accepted[0]!.divergence})` : ` (${fields} accepted divergence${fields > 1 ? 's' : ''}, ${accepted[0]!.divergence})`;
  return `${r.status}${failures ? ` (${failures} failing step${failures > 1 ? 's' : ''})` : ''} ${r.executed}/${r.total}${known}`;
}

/**
 * The scenario sections of VECTOR_PARITY.md, one per set with scenarios here ("S3 claim scenarios", "S4 signature
 * scenarios"): one row per scenario with its result on every world of `reports` ("not run" on a backend the scenario
 * does not run on), where its steps come from, and the findings of any run that is not a PASS. Public values only.
 */
export function renderScenarios(scenarios: readonly Scenario[], reports: readonly RunReport[]): string[] {
  const runs = reports.flatMap((r) => r.runs);
  const worlds = [...new Set(runs.map((r) => r.world))];
  const backendOf = (world: string) => (world === 'reference' ? 'reference' : (world.split('/')[0] as BackendChoice));
  const lines: string[] = [];
  for (const set of SCENARIO_SETS) {
    const mine = scenarios.filter((s) => scenarioSetOf(s) === set);
    if (!mine.length) continue;
    if (lines.length) lines.push('');
    lines.push(`## ${set.title}`, '', set.intro, '', `| Scenario | Covers | Built from | ${worlds.join(' | ')} |`, `| --- | --- | --- | ${worlds.map(() => '---').join(' | ')} |`);
    for (const s of mine) {
      const row = worlds.map((w) => (runsOn(s, backendOf(w)) ? cell(runs.find((r) => r.vector === s.vector.name && r.world === w)) : `not run (${s.backends.join(', ')} only)`));
      lines.push(`| ${s.vector.name} | ${s.covers.map((c) => `(${c})`).join(' ')} | ${s.parts.join('; ')} | ${row.join(' | ')} |`);
    }
    lines.push('');
    for (const s of mine) {
      const e = SCENARIO_EXPECTATIONS[s.vector.id];
      lines.push(`- ${s.vector.name}: ${s.vector.description}${e ? ` Expected on the merces and lockstep backends: ${describeExpected(e)}.` : ''}`);
    }
    const bad = runs.filter((r) => mine.some((s) => s.vector.name === r.vector) && (!r.atExpected || r.issues.some(isFinding)));
    if (bad.length) {
      lines.push('', '### Scenario findings', '');
      for (const r of bad) {
        lines.push(`- ${r.vector} on ${r.world}: ${r.status}, expected ${describeExpected(r.expected)}`);
        for (const i of r.issues.filter(isFinding)) lines.push(`  - #${i.index} \`${i.op}\`: ${i.message}`);
      }
    }
  }
  return lines;
}

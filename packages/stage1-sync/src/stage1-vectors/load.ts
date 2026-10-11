import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Call, Step, Vector } from '@merces/reference';
import { DEFAULT_PARAMETERS, parametersFromStrings, type Parameters } from '@merces/math';
import { RunnerError } from './errors.ts';

/** The vector format this runner reads (Stage 1 `packages/vectors/schema.json:12-13`). */
export const VECTOR_SCHEMA = 2;
export const VECTOR_SPEC_VERSION = '1.1';

export type VectorFlags = Vector['config']['flags'];
export type VectorKeys = Vector['keys'];

/**
 * One Stage 1 parity vector, ready to replay.
 *
 * Privacy (S1 plan §5.2, §7.4): `witness` (TEST ONLY income openings, Stage 1 `types.ts:59-67`) is deleted from every
 * `submit_report` at load, including the calls nested in `expect_revert`; `seriesPrivate` (the plaintext terms) is
 * dropped, only the series names that had one are kept. `keys` (the vectors' test keys) stays for the backends that
 * sign with them but is non-enumerable, so a report, a log line or `JSON.stringify` of a loaded vector never carries it.
 */
export interface LoadedVector {
  /** two-digit prefix, e.g. "01" */
  id: string;
  /** file name without `.json`, e.g. "01_happy_path" */
  name: string;
  file: string;
  description: string;
  parameters: Parameters;
  flags: VectorFlags;
  actors: string[];
  /** names of the series whose private terms the vector carried (the terms themselves are dropped) */
  privateSeries: string[];
  steps: Step[];
  /** non-enumerable; never print */
  readonly keys: VectorKeys;
  /** Trusted loader provenance for composed scenarios: base keys retain their base vector's namespace. */
  readonly keySeeds: Record<string, string>;
}

/** `NN_name.json` files in `dir`, sorted. */
export function listVectorFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d\d_.*\.json$/.test(f))
    .sort()
    .map((f) => join(resolve(dir), f));
}

/** Does `id` (e.g. "4", "04" or "04_zero_quarters") select the vector? */
export function selects(id: string, v: { id: string; name: string }): boolean {
  const s = id.trim().replace(/\.json$/, '');
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, '0') === v.id;
  return s === v.name;
}

/** The submit_report call of a step (top level or nested in expect_revert), if any. */
function reportCall(step: Record<string, unknown>): Record<string, unknown> | null {
  const call = (step.op === 'expect_revert' ? step.call : step) as Record<string, unknown> | undefined;
  return call && call.op === 'submit_report' ? call : null;
}

/** Parse and check one vector file. Throws `RunnerError` (public facts only) when it is not a vector this runner reads. */
export function loadVector(file: string): LoadedVector {
  const name = basename(file).replace(/\.json$/, '');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new RunnerError(`${name}: not a JSON file`);
  }
  return fromJson(raw, name, file);
}

/** As `loadVector`, from an already parsed object (tests mutate copies). The input is not modified. */
export function fromJson(input: Record<string, unknown>, name: string, file = name): LoadedVector {
  // work on a copy: the caller's object keeps its fields, ours loses the private ones
  const raw = structuredClone(input);
  if (raw.schema !== VECTOR_SCHEMA) throw new RunnerError(`${name}: schema ${JSON.stringify(raw.schema)} is not ${VECTOR_SCHEMA}`);
  if (raw.specVersion !== VECTOR_SPEC_VERSION) throw new RunnerError(`${name}: specVersion ${JSON.stringify(raw.specVersion)} is not ${VECTOR_SPEC_VERSION}`);
  const config = raw.config as Vector['config'] | undefined;
  if (!config || typeof config !== 'object') throw new RunnerError(`${name}: no config`);
  if (!Array.isArray(raw.steps)) throw new RunnerError(`${name}: no steps`);
  const steps = raw.steps as Record<string, unknown>[];

  // parameters: Stage 1's own vector test ignores them (reference/test/vectors.test.ts:42) and runs the defaults, so a
  // vector generated with other parameters would replay against the wrong ones; refuse it and name the keys
  let parameters: Parameters;
  try {
    parameters = parametersFromStrings(config.parameters ?? {});
  } catch (e) {
    throw new RunnerError(`${name}: config.parameters: ${e instanceof Error ? e.message : 'unreadable'}`);
  }
  const differing = (Object.keys(DEFAULT_PARAMETERS) as (keyof Parameters)[]).filter((k) => String(parameters[k]) !== String(DEFAULT_PARAMETERS[k]));
  if (differing.length) throw new RunnerError(`${name}: config.parameters differ from Stage 1's DEFAULT_PARAMETERS at ${differing.join(', ')}`);

  const f = config.flags as Partial<VectorFlags> | undefined;
  if (!f || typeof f.newRaisesPaused !== 'boolean' || typeof f.windowsEnabled !== 'boolean' || typeof f.tier4Enabled !== 'boolean') {
    throw new RunnerError(`${name}: config.flags must carry newRaisesPaused, windowsEnabled and tier4Enabled`);
  }
  const flags: VectorFlags = { newRaisesPaused: f.newRaisesPaused, windowsEnabled: f.windowsEnabled, tier4Enabled: f.tier4Enabled };

  for (const [i, s] of steps.entries()) {
    if (!s || typeof s !== 'object' || typeof s.op !== 'string') throw new RunnerError(`${name}: step #${i} has no op`);
    if (typeof s.t !== 'string' || !/^\d+$/.test(s.t)) throw new RunnerError(`${name}: step #${i} has no decimal t`);
    if (s.op === 'expect_revert' && (!s.call || typeof (s.call as { op?: unknown }).op !== 'string' || typeof s.error !== 'string')) {
      throw new RunnerError(`${name}: step #${i} expect_revert needs call.op and error`);
    }
    // TEST ONLY income openings: gone before anything else sees the step
    const report = reportCall(s);
    if (report) delete report.witness;
  }

  const id = /^(\d\d)_/.exec(name)?.[1];
  if (!id) throw new RunnerError(`${name}: file name must start with two digits`);
  const out = {
    id,
    name,
    file,
    description: typeof raw.description === 'string' ? raw.description : '',
    parameters,
    flags,
    actors: Array.isArray(raw.actors) ? (raw.actors as string[]) : [],
    privateSeries: raw.seriesPrivate && typeof raw.seriesPrivate === 'object' ? Object.keys(raw.seriesPrivate).sort() : [],
    steps: steps as unknown as Step[],
  } as Omit<LoadedVector, 'keys' | 'keySeeds'>;
  Object.defineProperty(out, 'keys', { value: (raw.keys ?? {}) as VectorKeys, enumerable: false, writable: false });
  Object.defineProperty(out, 'keySeeds', { value: Object.fromEntries(Object.keys(raw.keys ?? {}).map((key) => [key, `${name}:${key}`])), enumerable: false, writable: false });
  return out as LoadedVector;
}

/** Load the vectors of `dir`, optionally only those `only` selects (ids such as "01" or full names). */
export function loadVectors(dir: string, only?: readonly string[]): LoadedVector[] {
  const files = listVectorFiles(dir);
  if (files.length === 0) throw new RunnerError(`no NN_name.json vectors in ${dir}`);
  const all = files.map((f) => ({ file: f, name: basename(f).replace(/\.json$/, ''), id: basename(f).slice(0, 2) }));
  const chosen = only?.length ? all.filter((v) => only.some((o) => selects(o, v))) : all;
  if (only?.length) {
    const unknown = only.filter((o) => !all.some((v) => selects(o, v)));
    if (unknown.length) throw new RunnerError(`no vector matches ${unknown.join(', ')}`);
  }
  return chosen.map((v) => loadVector(v.file));
}

/** The call a step runs (the step itself, or the call nested in expect_revert); null for `expect`. */
export function callOf(step: Step): Call | null {
  if (step.op === 'expect') return null;
  if (step.op === 'expect_revert') return step.call;
  return step as unknown as Call;
}

/** A step's op as reports name it: `expect_revert <call op>` for a revert, the op otherwise. */
export function opLabel(step: Step): string {
  return step.op === 'expect_revert' ? `expect_revert ${step.call.op}` : step.op;
}

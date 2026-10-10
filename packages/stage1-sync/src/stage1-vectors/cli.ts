#!/usr/bin/env tsx
/**
 * pnpm stage1:vectors [--backend merces|reference|lockstep] [--only 01,04] [--personality solana,monad]
 *                     [--until <step index, inclusive>] [--stop-before <op>] [--out <dir>] [--dir <vectors dir>] [--json]
 * pnpm stage1:vectors --scenarios [--backend lockstep|merces|reference] [--only S3a,S3f] [--personality …] [--json]
 *
 * Replays Stage 1's parity vectors (S1 plan §5). The vectors directory defaults to the one the Stage 1 checkout's
 * manifest names (STAGE1_PATH, else the pinned `stage1` submodule). Backends: `merces` (default; our simulator, the
 * targets in full and the prefix-gated vectors to their gate, on both personalities, unless `--only`; `--until`
 * replaces a gate), `reference` (Stage 1's own simulator, every vector) and `lockstep` (both side by side, stopping at
 * the first step after which they disagree; a recorded parting is accepted). `--scenarios` replays our own scenarios
 * instead (`scenarios.ts`: the S3 claim and S4 signature sets; default backend `lockstep`), each of which must be at its
 * expected status; a scenario that does not run on the backend (S4d runs on `merces` only) is named and skipped. Exit code 0 when every run
 * is at its expected status, 1 when one is not, 2 on a usage or runner error.
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { locateStage1, stage1Path } from '@merces/chains';
import { RunnerError, runScenarios, runStage1Vectors, renderSummary, shutdown, writeParity, PERSONALITIES, type BackendChoice, type RunReport, type VectorPersonality } from './index.ts';

const USAGE = 'usage: stage1:vectors [--backend merces|reference|lockstep] [--only 01,04] [--personality solana,monad] [--until <idx>] [--stop-before <op>] [--out <dir>] [--dir <vectors dir>] [--json]\n       stage1:vectors --scenarios [--backend lockstep|merces|reference] [--only S3a,S3f] [--personality solana,monad] [--dir <vectors dir>] [--json]';

interface Args {
  backend?: BackendChoice;
  scenarios: boolean;
  only?: string[];
  personalities?: VectorPersonality[];
  until?: number;
  stopBefore?: string;
  out?: string;
  dir?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scenarios: false, json: false };
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--') continue;
    if (flag === '--json') {
      a.json = true;
      continue;
    }
    if (flag === '--scenarios') {
      a.scenarios = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') throw new RunnerError(USAGE);
    const eq = flag.indexOf('=');
    const name = eq > 0 ? flag.slice(0, eq) : flag;
    const value = eq > 0 ? flag.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new RunnerError(`${name} needs a value\n${USAGE}`);
    switch (name) {
      case '--backend':
        if (value !== 'merces' && value !== 'reference' && value !== 'lockstep') throw new RunnerError(`unknown backend ${value}\n${USAGE}`);
        a.backend = value;
        break;
      case '--only':
        a.only = list(value);
        break;
      case '--personality': {
        const ps = list(value);
        const bad = ps.filter((p) => !(PERSONALITIES as readonly string[]).includes(p));
        if (bad.length) throw new RunnerError(`unknown personality ${bad.join(', ')} (solana, monad)`);
        a.personalities = ps as VectorPersonality[];
        break;
      }
      case '--until':
        if (!/^\d+$/.test(value)) throw new RunnerError(`--until takes a step index\n${USAGE}`);
        a.until = Number(value);
        break;
      case '--stop-before':
        a.stopBefore = value;
        break;
      case '--out':
        a.out = value;
        break;
      case '--dir':
        a.dir = value;
        break;
      default:
        throw new RunnerError(`unknown option ${name}\n${USAGE}`);
    }
  }
  return a;
}

function vectorsDir(explicit: string | undefined): { dir: string; label: string; commit?: string } {
  if (explicit) return { dir: explicit, label: explicit };
  const loc = locateStage1(process.env.STAGE1_PATH ?? (existsSync('stage1/SPEC.md') ? 'stage1' : undefined));
  if (!loc) throw new RunnerError('Stage 1 not present: set STAGE1_PATH, check out the stage1 submodule, or pass --dir');
  const dir = stage1Path(loc, loc.manifest.vectors);
  if (!dir || !existsSync(dir)) throw new RunnerError(`the Stage 1 manifest at ${loc.path} names no vectors directory`);
  return { dir, label: `$STAGE1_PATH/${relative(loc.root, dir)}`, ...(loc.manifest.commit ? { commit: loc.manifest.commit } : {}) };
}

let code = 2;
try {
  const args = parseArgs(process.argv.slice(2));
  const src = vectorsDir(args.dir);
  let report: RunReport;
  let skipped: string[] = [];
  if (args.scenarios) {
    // a scenario runs whole: no gates, and VECTOR_PARITY.md is the vectors' (pnpm stage1:sync adds the scenarios' section)
    if (args.until !== undefined || args.stopBefore || args.out) throw new RunnerError(`--scenarios takes no --until, --stop-before or --out\n${USAGE}`);
    const r = await runScenarios({ vectorsDir: src.dir, ...(args.backend ? { backend: args.backend } : {}), ...(args.only ? { only: args.only } : {}), ...(args.personalities ? { personalities: args.personalities } : {}) });
    report = r.report;
    // a scenario that does not run on this backend (a merces-only one on the reference or in lockstep) is named, not run
    skipped = r.skipped.map((s) => `  skip ${s.vector.name}: runs on ${s.backends.join(', ')} only`);
  } else {
    report = await runStage1Vectors({
      dir: src.dir,
      backend: args.backend ?? 'merces',
      ...(args.only ? { only: args.only } : {}),
      ...(args.personalities ? { personalities: args.personalities } : {}),
      ...(args.until !== undefined ? { until: args.until } : {}),
      ...(args.stopBefore ? { stopBefore: args.stopBefore } : {}),
    });
  }
  if (args.json) console.log(JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
  else console.log([renderSummary([report]), ...skipped].join('\n'));
  if (args.out) console.log(`wrote ${writeParity(args.out, [report], { dir: src.label, ...(src.commit ? { commit: src.commit } : {}) })}`);
  const pass = report.runs.filter((r) => r.status === 'PASS').length;
  // prefix runs replay to their gate (PREFIX-PASS) and count as PASS when every step up to it passed
  const prefix = report.runs.filter((r) => r.expected.status === 'PREFIX-PASS').length;
  const diverging = report.runs.filter((r) => r.status === 'PASS-WITH-DIVERGENCES').length;
  const notes = [...(prefix ? [`${prefix} prefix run${prefix > 1 ? 's' : ''}`] : []), ...(diverging ? [`${diverging} run${diverging > 1 ? 's' : ''} with accepted divergences`] : [])];
  if (!args.json) console.log(`${report.ok ? 'OK' : 'NOT OK'}: ${pass}/${report.runs.length} PASS, ${report.runs.filter((r) => r.atExpected).length}/${report.runs.length} at expected status${notes.length ? ` (${notes.join('; ')})` : ''}`);
  code = report.ok ? 0 : 1;
} catch (e) {
  // runner errors carry public facts only; anything else is reported by class
  console.error(e instanceof RunnerError ? e.message : `stage1:vectors failed: ${e instanceof Error ? e.constructor.name : typeof e}`);
  code = 2;
} finally {
  await shutdown();
}
process.exit(code);

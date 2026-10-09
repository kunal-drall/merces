import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stage1Path } from '@merces/chains';
import { interimMath, type MercesMath } from '@merces/math';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';
import { compareStage1Math, renderStage1Math } from './stage1-math.ts';

/**
 * Step 4: run Stage 1's reference math against ours on every vector and report disagreement to the base unit.
 * Proven parity makes Stage 1's library eligible to replace the interim one; it does not swap anything at runtime
 * (services import the interim functions directly and this runs in the short-lived sync process).
 *
 * Stage 1's package must export an object satisfying `MercesMath` (or a `mercesMath` adapter). Vectors:
 * { "math": [ { "fn": "owedYtd", "args": ["..."], "expect": "..." }, ... ] } with bigint arguments as strings.
 * Results are compared exactly after canonicalisation, so a function returning an object needs the full expected
 * object (every field, bigints as decimal strings).
 */
export async function swapMath(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const details: string[] = [];
  if (!m.math?.package) return { step: 'math', status: 'warn', summary: 'manifest has no math package; keeping the interim implementation', details };
  const pkg = m.math.package;
  const entry = resolveMathEntry(ctx.location.root, pkg);
  if ('error' in entry) return { step: 'math', status: 'fail', summary: entry.error, details };
  let mod: Record<string, unknown>;
  try {
    mod = (await import(entry.specifier)) as Record<string, unknown>;
  } catch (e) {
    return { step: 'math', status: 'fail', summary: `cannot load Stage 1 math ${pkg}: ${(e as Error).message}`, details };
  }
  const adapter = (mod.mercesMath ?? (typeof mod.default === 'object' ? mod.default : undefined)) as MercesMath | undefined;
  if (!adapter) return compareFunctionByFunction(ctx, pkg, mod);
  const theirs: MercesMath = adapter;
  const missingFns = (Object.keys(interimMath) as (keyof MercesMath)[]).filter((k) => typeof theirs[k] !== 'function');
  if (missingFns.length) details.push(`Stage 1 math lacks: ${missingFns.join(', ')} (adapter needed)`);

  const vectorsPath = stage1Path(ctx.location, m.vectors);
  let compared = 0;
  let disagreements = 0;
  const lines: string[] = ['# MATH_PARITY.md', '', `Stage 1 math: ${pkg}`, ''];
  if (vectorsPath && existsSync(vectorsPath) && statSync(vectorsPath).isFile()) {
    const raw = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { math?: { fn: keyof MercesMath; args: unknown[]; expect: unknown }[] };
    for (const v of raw.math ?? []) {
      compared++;
      const args = v.args.map(decodeArg);
      const ours = safe(() => (interimMath[v.fn] as (...a: unknown[]) => unknown)(...args));
      const stage1 = typeof theirs[v.fn] === 'function' ? safe(() => (theirs[v.fn] as (...a: unknown[]) => unknown)(...args)) : 'absent';
      const o = canon(ours);
      const t = canon(stage1);
      const e = canon(v.expect);
      if (o !== e || t !== e) {
        disagreements++;
        lines.push(`- DISAGREE ${String(v.fn)}(${v.args.join(', ')}): expected ${e}, interim ${o}, stage1 ${t}`);
      }
    }
    lines.push('', `${compared} vector(s), ${disagreements} disagreement(s).`);
  } else {
    lines.push('No math vectors found; parity unproven.');
  }
  writeFileSync(join(ctx.outDir, 'MATH_PARITY.md'), lines.join('\n') + '\n');
  details.push(`${compared} vector(s) compared, ${disagreements} disagreement(s)`);
  if (missingFns.length === 0 && compared > 0 && disagreements === 0) {
    details.push(`${pkg} is eligible to replace the interim library; not wired at runtime (services still use the interim math)`);
    return { step: 'math', status: 'ok', summary: 'parity proven; Stage 1 math eligible to replace the interim library (not wired at runtime)', details };
  }
  return { step: 'math', status: disagreements > 0 ? 'fail' : 'warn', summary: disagreements > 0 ? 'math disagreement (see MATH_PARITY.md)' : 'parity unproven; interim math kept', details };
}

/**
 * Where to import Stage 1's math from. A path (relative to the Stage 1 root) to a package directory resolves through
 * its package.json `exports`/`main`; an unbuilt package is reported with the command that builds it. Anything else is
 * imported as a bare specifier.
 */
export function resolveMathEntry(root: string, pkg: string): { specifier: string } | { error: string } {
  const p = resolve(root, pkg);
  if (!existsSync(p)) {
    if (pkg.startsWith('.') || pkg.startsWith('/')) return { error: `Stage 1 math ${pkg} not found at ${p}` };
    return { specifier: pkg };
  }
  if (!statSync(p).isDirectory()) return { specifier: pathToFileURL(p).href };
  const manifest = join(p, 'package.json');
  if (!existsSync(manifest)) return { error: `Stage 1 math ${pkg} has no package.json` };
  const pj = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; main?: string; exports?: Record<string, unknown> };
  const dot = pj.exports?.['.'];
  const rel = (typeof dot === 'string' ? dot : (dot as { import?: string; default?: string } | undefined)?.import ?? (dot as { default?: string } | undefined)?.default) ?? pj.main ?? 'index.js';
  const file = resolve(p, rel);
  if (!existsSync(file)) {
    return { error: `Stage 1 math ${pj.name ?? pkg} is not built (${rel} missing): run \`pnpm install && pnpm -r --filter '${pj.name ?? pkg}...' build\` in the Stage 1 checkout` };
  }
  return { specifier: pathToFileURL(file).href };
}

/** Stage 1 ships its own function shapes, not a `MercesMath` object: compare family by family (stage1-math.ts). */
function compareFunctionByFunction(ctx: StepCtx, pkg: string, mod: Record<string, unknown>): StepReport {
  const r = compareStage1Math(mod);
  writeFileSync(join(ctx.outDir, 'MATH_PARITY.md'), renderStage1Math(pkg, r));
  const compared = r.families.filter((f) => f.cases > 0);
  const disagreeing = compared.filter((f) => f.disagreements > 0);
  const details = [
    `${compared.length} function famil${compared.length === 1 ? 'y' : 'ies'} compared on ${compared.reduce((a, f) => a + f.cases, 0)} input(s); ${disagreeing.length} disagree (see MATH_PARITY.md)`,
    ...disagreeing.map((f) => `${f.name}: ${f.disagreements}/${f.cases} disagree (ours \`${f.ours}\`, Stage 1 \`${f.stage1}\`)`),
    ...(r.missing.length ? [`Stage 1 lacks: ${r.missing.join(', ')}`] : []),
  ];
  if (disagreeing.length) return { step: 'math', status: 'fail', summary: `math disagreement in ${disagreeing.length} famil${disagreeing.length === 1 ? 'y' : 'ies'} (Stage 1 wins; see MATH_PARITY.md)`, details };
  if (r.missing.length || compared.length === 0) return { step: 'math', status: 'warn', summary: 'parity unproven; interim math kept', details };
  return { step: 'math', status: 'ok', summary: 'every compared family agrees with Stage 1; interim math kept until the vectors replay', details };
}

/**
 * Canonical form for comparison: bigints and numbers as decimal strings, object keys sorted, arrays in order.
 * String() would turn every object into "[object Object]" and let any two objects agree.
 */
export function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => {
    if (typeof v === 'bigint' || typeof v === 'number') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    return v;
  }) ?? 'undefined';
}

function safe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    return `throws(${(e as Error).message})`;
  }
}

/**
 * Vector arguments carry bigints as decimal strings, at any depth (clearAuction, quarterPayment and friends take
 * objects). Decode them recursively; JSON numbers stay numbers so integer-typed fields keep their type.
 */
export function decodeArg(a: unknown): unknown {
  if (typeof a === 'string') return /^-?\d+$/.test(a) ? BigInt(a) : a;
  if (Array.isArray(a)) return a.map(decodeArg);
  if (a && typeof a === 'object') return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, decodeArg(v)]));
  return a;
}

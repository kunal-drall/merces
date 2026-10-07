import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stage1Path } from '@merces/chains';
import { interimMath, selectMath, type MercesMath } from '@merces/math';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';

/**
 * Step 4: run Stage 1's reference math against ours on every vector; report disagreement to the base unit;
 * switch @merces/math to Stage 1's library only when every vector agrees.
 *
 * Stage 1's package must export an object satisfying `MercesMath` (or a `mercesMath` adapter). Vectors:
 * { "math": [ { "fn": "owedYtd", "args": ["..."], "expect": "..." }, ... ] } with bigint arguments as strings.
 */
export async function swapMath(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const details: string[] = [];
  if (!m.math?.package) return { step: 'math', status: 'warn', summary: 'manifest has no math package; keeping the interim implementation', details };
  const pkg = m.math.package;
  const resolved = pkg.startsWith('.') || pkg.startsWith('/') ? resolve(ctx.location.root, pkg) : pkg;
  let theirs: MercesMath;
  try {
    const mod = (await import(resolved.startsWith('/') ? pathToFileURL(resolved).href : resolved)) as Record<string, unknown>;
    theirs = (mod.mercesMath ?? mod.default ?? mod) as MercesMath;
  } catch (e) {
    return { step: 'math', status: 'fail', summary: `cannot load Stage 1 math ${pkg}: ${(e as Error).message}`, details };
  }
  const missingFns = (Object.keys(interimMath) as (keyof MercesMath)[]).filter((k) => typeof theirs[k] !== 'function');
  if (missingFns.length) details.push(`Stage 1 math lacks: ${missingFns.join(', ')} (adapter needed)`);

  const vectorsPath = stage1Path(ctx.location, m.vectors);
  let compared = 0;
  let disagreements = 0;
  const lines: string[] = ['# MATH_PARITY.md', '', `Stage 1 math: ${pkg}`, ''];
  if (vectorsPath && existsSync(vectorsPath)) {
    const raw = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { math?: { fn: keyof MercesMath; args: unknown[]; expect: unknown }[] };
    for (const v of raw.math ?? []) {
      compared++;
      const args = v.args.map((a) => (typeof a === 'string' && /^-?\d+$/.test(a) ? BigInt(a) : a));
      const ours = safe(() => (interimMath[v.fn] as (...a: unknown[]) => unknown)(...args));
      const stage1 = typeof theirs[v.fn] === 'function' ? safe(() => (theirs[v.fn] as (...a: unknown[]) => unknown)(...args)) : 'absent';
      const o = String(ours);
      const t = String(stage1);
      const e = String(v.expect);
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
    selectMath(theirs, pkg);
    details.push(`switched @merces/math to ${pkg}`);
    return { step: 'math', status: 'ok', summary: 'parity proven; Stage 1 math selected', details };
  }
  return { step: 'math', status: disagreements > 0 ? 'fail' : 'warn', summary: disagreements > 0 ? 'math disagreement (see MATH_PARITY.md)' : 'parity unproven; interim math kept', details };
}

function safe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    return `throws(${(e as Error).message})`;
  }
}

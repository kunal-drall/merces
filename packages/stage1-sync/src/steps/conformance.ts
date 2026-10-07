import { spawnSync } from 'node:child_process';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';

/** Step 6: run the adapter conformance suite (H2) against each live chain. */
export async function runConformance(ctx: StepCtx & { enabled: boolean }): Promise<StepReport> {
  if (!ctx.enabled) return { step: 'conformance', status: 'skipped', summary: 'skipped (--no-conformance)', details: [] };
  const m = ctx.location.manifest;
  const targets: string[] = [];
  if (m.solana?.programs) targets.push('solana');
  for (const e of m.evm ?? []) targets.push(`evm:${e.chain}`);
  if (targets.length === 0) return { step: 'conformance', status: 'warn', summary: 'no live chains to test', details: [] };
  const details: string[] = [];
  let failed = 0;
  for (const t of targets) {
    const r = spawnSync('pnpm', ['vitest', 'run', '--project', 'conformance'], { env: { ...process.env, CONFORMANCE_CHAIN: t, STAGE1_PATH: ctx.location.root, STAGE1_SYNC_GENERATED: ctx.generatedDir }, encoding: 'utf8' });
    const ok = r.status === 0;
    if (!ok) failed++;
    details.push(`[${t.replace(/^evm:/, '')}] ${ok ? 'conformance passed' : 'conformance FAILED (blocker)'}`);
    const tail = (r.stdout + r.stderr).split('\n').filter((l) => /Tests|FAIL|✓|×/.test(l)).slice(-6);
    for (const l of tail) details.push(`    ${l.trim()}`);
  }
  return { step: 'conformance', status: failed ? 'fail' : 'ok', summary: failed ? `${failed} chain(s) failed conformance` : 'conformance green on every live chain', details };
}

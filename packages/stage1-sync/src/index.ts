import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from './steps/detect.ts';
import type { ChainVerdict, StepReport, SyncReport } from './report.ts';
import { renderReport } from './report.ts';

export interface SyncOptions {
  stage1Path: string | undefined;
  outDir: string;
  generatedDir: string;
  runConformance: boolean;
  json: boolean;
}

/**
 * The stage1:sync pipeline (D5). Steps 2–6 are loaded lazily so that "Stage 1 not present" costs nothing and
 * each step can be developed independently. Every step writes its findings under outDir.
 */
export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const { location, report: detectReport } = detect(opts.stage1Path);
  const steps: StepReport[] = [detectReport];
  if (!location) {
    return { present: false, location: null, steps, verdicts: [] };
  }
  mkdirSync(opts.outDir, { recursive: true });
  const ctx = { location, outDir: opts.outDir, generatedDir: opts.generatedDir };

  const { generateClients } = await import('./steps/generate.ts');
  steps.push(await generateClients(ctx));
  const { diffInterfaces } = await import('./steps/diff.ts');
  steps.push(await diffInterfaces(ctx));
  const { swapMath } = await import('./steps/math.ts');
  steps.push(await swapMath(ctx));
  const { replayVectors } = await import('./steps/vectors.ts');
  steps.push(await replayVectors(ctx));
  const { runConformance } = await import('./steps/conformance.ts');
  steps.push(await runConformance({ ...ctx, enabled: opts.runConformance }));

  const verdicts = verdictsFrom(steps, location);
  const report: SyncReport = { present: true, location: location.path, steps, verdicts };
  writeFileSync(join(opts.outDir, 'stage1-sync-report.md'), renderReport(report) + '\n');
  writeFileSync(join(opts.outDir, 'stage1-sync-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

function verdictsFrom(steps: StepReport[], location: { manifest: { solana?: unknown; evm?: unknown[] } }): ChainVerdict[] {
  const blockersAll = steps.filter((s) => s.status === 'fail').map((s) => `${s.step}: ${s.summary}`);
  const out: ChainVerdict[] = [];
  const chains: string[] = [];
  if (location.manifest.solana) chains.push('solana');
  for (const e of (location.manifest.evm as { chain: string }[] | undefined) ?? []) chains.push(e.chain);
  for (const c of chains) {
    const own = steps.flatMap((s) => s.details.filter((d) => d.startsWith(`[${c}]`) && /fail|blocker/i.test(d)));
    const blockers = [...blockersAll, ...own];
    out.push({ chain: c, ready: blockers.length === 0, blockers });
  }
  return out;
}

export { renderReport };
export type { SyncReport, StepReport, ChainVerdict };

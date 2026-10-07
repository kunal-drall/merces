import { locateStage1, type Stage1Location } from '@merces/chains';
import type { StepReport } from '../report.ts';

/** Step 1: detect the manifest or the hand-written map. */
export function detect(stage1Path: string | undefined): { location: Stage1Location | null; report: StepReport } {
  const loc = locateStage1(stage1Path);
  if (!loc) return { location: null, report: { step: 'detect', status: 'skipped', summary: 'Stage 1 not present', details: [] } };
  const details: string[] = [];
  const m = loc.manifest;
  details.push(`kind=${loc.kind} version=${m.version ?? '?'} commit=${m.commit ?? '?'}`);
  details.push(`solana: ${m.solana?.programs ? Object.keys(m.solana.programs).length + ' programs' : 'absent'}; evm: ${m.evm?.length ?? 0} chain(s); math: ${m.math?.package ?? 'absent'}; vectors: ${m.vectors ?? 'absent'}; events schema: ${m.events?.schema ?? 'absent'}`);
  for (const p of loc.problems) details.push(`problem: ${p}`);
  return { location: loc, report: { step: 'detect', status: loc.problems.length ? 'warn' : 'ok', summary: `found ${loc.kind} at ${loc.path}`, details } };
}

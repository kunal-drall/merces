import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stage1Path } from '@merces/chains';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';
import { replayScenario, type ParityScenario } from '../vectors.ts';

/**
 * Step 5: replay Stage 1's parity vectors through the simulator. Every expected balance must match.
 * If it does not, the simulator is wrong and must be fixed (everything was tested against it).
 */
export async function replayVectors(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const vectorsPath = stage1Path(ctx.location, m.vectors);
  if (!vectorsPath || !existsSync(vectorsPath)) return { step: 'vectors', status: 'warn', summary: 'no parity vectors in the manifest', details: [] };
  const raw = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { scenarios?: ParityScenario[] };
  const scenarios = raw.scenarios ?? [];
  if (scenarios.length === 0) return { step: 'vectors', status: 'warn', summary: 'vectors file has no scenarios', details: [] };
  const details: string[] = [];
  const lines: string[] = ['# VECTOR_PARITY.md', ''];
  let failures = 0;
  for (const sc of scenarios) {
    for (const personality of (sc.personalities ?? ['solana', 'monad']) as Personality[]) {
      const sim = SimulatorChain.createSync({ personality, genesis: sc.genesis });
      const h = await SimHarness.create(personality, { sim });
      const r = await replayScenario(h, sc);
      if (r.mismatches.length) {
        failures++;
        lines.push(`## ${sc.name} (${personality}): FAIL`, ...r.mismatches.map((x) => `- ${x}`), '');
        details.push(`${sc.name}/${personality}: ${r.mismatches.length} mismatch(es)`);
      } else lines.push(`## ${sc.name} (${personality}): ok (${r.steps} steps)`, '');
    }
  }
  writeFileSync(join(ctx.outDir, 'VECTOR_PARITY.md'), lines.join('\n') + '\n');
  return { step: 'vectors', status: failures ? 'fail' : 'ok', summary: failures ? `${failures} scenario run(s) disagree with the simulator` : `${scenarios.length} scenario(s) reproduced`, details };
}

#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { shutdownProofSystem } from '@merces/ports';
import { runSync } from './index.ts';
import { renderReport } from './report.ts';

const args = new Set(process.argv.slice(2));
const report = await runSync({
  // STAGE1_PATH overrides; otherwise the pinned `stage1` submodule
  stage1Path: process.env.STAGE1_PATH ?? (existsSync('stage1/SPEC.md') ? 'stage1' : undefined),
  outDir: process.env.STAGE1_SYNC_OUT ?? 'packages/stage1-sync/out',
  generatedDir: process.env.STAGE1_SYNC_GENERATED ?? 'packages/stage1-sync/generated',
  runConformance: !args.has('--no-conformance'),
  json: args.has('--json'),
});
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(renderReport(report));
const failed = report.present && report.steps.some((s) => s.status === 'fail');
// the vectors step verifies Stage 1 Groth16 proofs: terminate snarkjs' worker threads before exiting
await shutdownProofSystem();
process.exit(failed ? 1 : 0);

#!/usr/bin/env tsx
import { runSync } from './index.ts';
import { renderReport } from './report.ts';

const args = new Set(process.argv.slice(2));
const report = await runSync({
  stage1Path: process.env.STAGE1_PATH,
  outDir: process.env.STAGE1_SYNC_OUT ?? 'packages/stage1-sync/out',
  generatedDir: process.env.STAGE1_SYNC_GENERATED ?? 'packages/stage1-sync/generated',
  runConformance: !args.has('--no-conformance'),
  json: args.has('--json'),
});
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(renderReport(report));
const failed = report.present && report.steps.some((s) => s.status === 'fail');
process.exit(failed ? 1 : 0);

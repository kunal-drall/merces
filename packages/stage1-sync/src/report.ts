export type StepStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface StepReport {
  step: string;
  status: StepStatus;
  summary: string;
  details: string[];
}

export interface ChainVerdict {
  chain: string;
  ready: boolean;
  blockers: string[];
}

export interface SyncReport {
  present: boolean;
  location: string | null;
  steps: StepReport[];
  verdicts: ChainVerdict[];
}

export function renderReport(r: SyncReport): string {
  const lines: string[] = [];
  lines.push('stage1:sync');
  lines.push('===========');
  if (!r.present) {
    lines.push('Stage 1 not present. Set STAGE1_PATH to the Stage 1 checkout (directory containing handoff/manifest.json or stage1.map.json).');
    lines.push('All chains run on the simulator.');
    return lines.join('\n');
  }
  lines.push(`Stage 1 located at ${r.location}`);
  for (const s of r.steps) {
    lines.push(`- [${s.status.toUpperCase().padEnd(7)}] ${s.step}: ${s.summary}`);
    for (const d of s.details) lines.push(`    ${d}`);
  }
  lines.push('');
  lines.push('Verdict');
  // the ported curve family's gate (A-MATH-3) is reported here whatever its status; a failure is also a blocker below
  const curve = r.steps.find((s) => s.step === 'curve-port');
  if (curve) lines.push(`  ported curve family (curve-port): ${curve.status.toUpperCase()} — ${curve.summary}`);
  for (const v of r.verdicts) {
    lines.push(`  ${v.chain}: ${v.ready ? 'READY for live' : 'NOT ready'}${v.blockers.length ? ' — blockers:' : ''}`);
    for (const b of v.blockers) lines.push(`    • ${b}`);
  }
  return lines.join('\n');
}

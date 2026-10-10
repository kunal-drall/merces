import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief } from './compare.ts';
import { DIVERGENCES } from './divergences.ts';
import { EXPECTED, describeExpected, expectedFor } from './expected.ts';
import type { RunReport, RunResult } from './index.ts';
import { isFinding } from './run.ts';
import { SHIMS } from './shims.ts';

/** Where the vectors came from, as the report names it (a path relative to the Stage 1 checkout, and its commit). */
export interface ParitySource {
  dir: string;
  commit?: string;
}

const MAX_DIFFS_SHOWN = 12;

function cell(r: RunResult | undefined): string {
  if (!r) return '—';
  const failures = r.issues.filter((i) => i.kind === 'fail').length;
  const accepted = r.issues.filter((i) => i.kind === 'divergence');
  const fields = accepted.reduce((n, i) => n + (i.diffs?.length ?? 0), 0);
  const partial = r.stopped && (r.stopped.reason === 'until' || r.stopped.reason === 'stop-before') ? `, stopped at #${r.stopped.index} (${r.stopped.reason})` : '';
  // lockstep stops where the backends part, so a recorded parting is named where it happened
  const parted = r.backend === 'lockstep' && accepted[0] ? `, diverged at #${accepted[0].index} as recorded (${accepted[0].divergence})` : '';
  const known = r.backend !== 'lockstep' && fields ? ` (${fields} accepted divergence${fields > 1 ? 's' : ''})` : '';
  return `${r.status}${failures ? ` (${failures} failing step${failures > 1 ? 's' : ''})` : ''}${known} ${r.executed}/${r.total}${partial}${parted}`;
}

/** One line per run, for terminals. */
export function renderSummary(reports: readonly RunReport[]): string {
  const lines: string[] = [];
  for (const rep of reports) {
    const at = rep.runs.filter((r) => r.atExpected).length;
    lines.push(`backend ${rep.backend}: ${at}/${rep.runs.length} at expected status${rep.notRun.length ? `, ${rep.notRun.length} not replayed (NOT-YET)` : ''}; proofs: ${rep.proofs.verified} verified, ${rep.proofs.invalid} invalid`);
    for (const r of rep.runs) {
      const gate = r.expected.status === 'PREFIX-PASS' ? ` [prefix gate to #${r.expected.until}]` : '';
      lines.push(`  ${r.atExpected ? 'ok  ' : 'MISS'} ${r.vector} [${r.world}] ${cell(r)}${gate}${r.atExpected ? '' : ` — expected ${describeExpected(r.expected)}`}`);
      for (const i of r.issues.filter((x) => isFinding(x) || x.kind === 'divergence').slice(0, 5)) {
        lines.push(`         #${i.index} ${i.op}: ${i.message}`);
        for (const d of (i.diffs ?? []).slice(0, 5)) lines.push(`           ${d.path}: expected ${brief(d.expected, 80)}, got ${brief(d.actual, 80)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * `VECTOR_PARITY.md` (S1 plan §5.1, S2 WP5): results per vector and world, the findings with leaf-path diffs, the
 * known divergences (recorded, accepted, not parity), the prefix gates, waived and blocked steps, and the shims the runs
 * used ("not parity"). Public values only: vector and op names, step indices, error names, expect values.
 * Deterministic (no timings) so the committed copy changes only when results do.
 */
export function renderParity(reports: readonly RunReport[], source: ParitySource, extra: { notes?: string[]; sections?: string[] } = {}): string {
  const runs = reports.flatMap((r) => r.runs);
  const worlds = [...new Set(runs.map((r) => r.world))];
  const vectors = [...new Map([...runs.map((r) => [r.vector, r.id] as const), ...reports.flatMap((r) => r.notRun.map((n) => [n.vector, n.id] as const))]).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const proofs = reports.reduce((acc, r) => ({ verified: Math.max(acc.verified, r.proofs.verified), invalid: Math.max(acc.invalid, r.proofs.invalid) }), { verified: 0, invalid: 0 });

  const lines: string[] = [
    '# VECTOR_PARITY.md',
    '',
    `Stage 1 parity vectors in ${source.dir}${source.commit ? ` at ${source.commit}` : ''} (schema 2, SPEC 1.1), replayed by the Stage 1 vector runner (\`packages/stage1-sync/src/stage1-vectors\`, \`pnpm stage1:vectors\`).`,
    '',
    `Every \`expect\` compares the keys it carries, each as a whole value; every \`expect_revert\` must raise the named Stage 1 error, the transaction that raised must leave the state and the event log unchanged (checked before the merces backend restores anything), and the world must then be as it was before the call; Σ stablecoin equals Σ \`fund\` after every step, and the unit supply holds at every \`expect\`. Proofs are verified for real with the ports' \`Groth16ReportVerifier\` (Stage 1's verifier and development verification key): ${proofs.verified} distinct proofs, ${proofs.invalid} invalid (the vectors' deliberate tamper cases).`,
    '',
    ...(extra.notes?.length ? [...extra.notes, ''] : []),
    '## Results',
    '',
    `| Vector | ${worlds.join(' | ')} | Expected after S3 (merces) |`,
    `| --- | ${worlds.map(() => '---').join(' | ')} | --- |`,
  ];
  for (const [name, id] of vectors) {
    const row = worlds.map((w) => cell(runs.find((r) => r.vector === name && r.world === w)));
    lines.push(`| ${name} | ${row.join(' | ')} | ${describeExpected(expectedFor(id))} |`);
  }

  const findings = runs.filter((r) => r.issues.some(isFinding));
  lines.push('', '## Findings', '');
  if (!findings.length) lines.push(`None: every replayed step matched${runs.some((r) => r.issues.some((i) => i.kind === 'divergence')) ? ', the known divergences below aside' : ''}.`, '');
  for (const r of findings) {
    lines.push(`### ${r.vector} on ${r.world}: ${r.status}${r.atExpected ? ' (at expected status)' : ''}`, '');
    for (const i of r.issues.filter(isFinding)) {
      lines.push(`- #${i.index} \`${i.op}\`${i.shimId ? ` (${i.shimId})` : ''}: ${i.message}`);
      const diffs = i.diffs ?? [];
      for (const d of diffs.slice(0, MAX_DIFFS_SHOWN)) lines.push(`  - \`${d.path}\`: expected ${brief(d.expected)}, got ${brief(d.actual)}`);
      if (diffs.length > MAX_DIFFS_SHOWN) lines.push(`  - … ${diffs.length - MAX_DIFFS_SHOWN} more`);
    }
    if (r.stopped?.reason === 'diverged') lines.push(`- replay stopped at #${r.stopped.index}: the states diverged`);
    if (r.stopped?.reason === 'too-many-failures') lines.push(`- replay stopped at #${r.stopped.index}: too many failing steps`);
    lines.push('');
  }

  lines.push(
    '## Known divergences (not parity)',
    '',
    "Stage 1 behaviour the merces backend knowingly does not mirror (the register, `stage1-vectors/divergences.ts`). Each is recorded per `expect` step and field with Stage 1's value and ours (`expected.ts`): a difference equal to a recorded entry is accepted and the run is PASS-WITH-DIVERGENCES; another value at that field fails, and an entry whose difference no longer occurs fails as stale. In lockstep the backends must part right after the recorded step on exactly the recorded fields; the replay stops there.",
    '',
  );
  for (const row of DIVERGENCES) {
    lines.push(`### ${row.id}: ${row.title}`, '', `- What: ${row.what}`, `- Why: ${row.why}`, `- Seen: ${row.seen}`, `- Until: ${row.milestone}`, `- Lifting it: ${row.lift.join(' ')}`, '', '| Vector | Step | Field | Stage 1 | Ours |', '| --- | --- | --- | --- | --- |');
    for (const [id, e] of Object.entries(EXPECTED).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const name = vectors.find(([, vid]) => vid === id)?.[0] ?? id;
      for (const d of (e.divergences ?? []).filter((x) => x.id === row.id)) lines.push(`| ${name} | #${d.step} | \`${d.path}\` | ${brief(d.stage1)} | ${brief(d.ours)} |`);
      if (e.lockstep?.id === row.id) for (const d of e.lockstep.diffs) lines.push(`| ${name} (lockstep) | after #${e.lockstep.divergesAt} | \`${d.path}\` | ${brief(d.stage1)} | ${brief(d.ours)} |`);
    }
    const seen = runs.filter((r) => r.issues.some((i) => i.kind === 'divergence' && i.divergence === row.id));
    lines.push('');
    if (!seen.length) lines.push('Not reached by the runs of this report.');
    for (const r of seen) {
      const at = r.issues.filter((i) => i.kind === 'divergence' && i.divergence === row.id);
      lines.push(`- ${r.vector} on ${r.world}: ${at.map((i) => `#${i.index} (${i.diffs?.length ?? 0} field${(i.diffs?.length ?? 0) > 1 ? 's' : ''})`).join(', ')}, as recorded`);
    }
    lines.push('');
  }

  const gates = Object.entries(EXPECTED).filter(([, e]) => e.status === 'PREFIX-PASS').sort(([a], [b]) => (a < b ? -1 : 1));
  lines.push(
    '## Prefix gates',
    '',
    "A vector that needs a later milestone is replayed on the merces backend up to its gate, the last step before the first one the merces backend cannot run yet; every step up to the gate must pass (PREFIX-PASS), so the auction prefix and everything else before the gate stays protected. Gates measured on S2 and again on S3 WP2, unchanged: a full replay's first finding is the step after each gate, on both personalities and in lockstep.",
    '',
    '| Vector | Replayed to | Next step | The whole vector |',
    '| --- | --- | --- | --- |',
  );
  for (const [id, e] of gates) lines.push(`| ${vectors.find(([, vid]) => vid === id)?.[0] ?? id} | #${e.until} | ${e.next ?? '—'} | ${e.milestone ?? '?'}: ${e.reason ?? ''} |`);
  lines.push('');

  const waived = runs.flatMap((r) => r.issues.filter((i) => i.waived).map((i) => ({ r, i })));
  lines.push('## Waived steps', '');
  if (!waived.length) lines.push('None.');
  for (const { r, i } of waived) lines.push(`- ${r.vector} #${i.index} \`${i.op}\` on ${r.world}: ${i.kind.toUpperCase()}${i.shimId ? ` (${i.shimId})` : ''}, waived`);

  const atomic = runs.flatMap((r) => r.runnerAtomic.map((a) => ({ r, a })));
  lines.push(
    '',
    '## Runner-atomic reverts',
    '',
    'Expected reverts of a call the merces backend carries out as several transactions, where some went through before one raised the expected error: the runner undid them, so the call reverted as a whole by the runner\'s doing, not the engine\'s (not parity).',
    '',
  );
  if (!atomic.length) lines.push('None: every expected revert raised in the call\'s first transaction.');
  for (const { r, a } of atomic) lines.push(`- ${r.vector} #${a.index} \`${a.op}\`${a.shimId ? ` (${a.shimId})` : ''} on ${r.world}: ${a.rolledBack} transaction${a.rolledBack > 1 ? 's' : ''} undone by the runner`);

  const used = new Map<string, Set<string>>();
  for (const r of runs) for (const id of Object.keys(r.shims)) (used.get(id) ?? used.set(id, new Set()).get(id)!).add(r.vector.slice(0, 2));
  for (const r of runs) for (const i of r.issues) if (i.shimId) (used.get(i.shimId) ?? used.set(i.shimId, new Set()).get(i.shimId)!).add(r.vector.slice(0, 2));
  lines.push(
    '',
    '## Shims (not parity)',
    '',
    'The merces backend runs these Stage 1 ops through canonical calls of another shape (S1 plan §5.3). A step run through a shim is executed and checked, but it is not parity for that op; `blocked` and `n/a` rows are not run at all. A runner-atomic row may send several transactions for one Stage 1 call, and the runner undoes the ones that went through when a later one reverts. The reference backend runs Stage 1\'s own simulator and uses none of them. "Used in" lists the vectors of this report that went through the row, the calls of `expect_revert` steps included.',
    '',
    '| ID | Stage 1 op | Our call | Why it is a shim | Removed in | Used in |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const s of SHIMS) {
    const v = used.get(s.id);
    const kind = s.kind === 'shim' ? (s.runnerAtomic ? ' (runner-atomic)' : '') : ` (${s.kind.toUpperCase()})`;
    lines.push(`| ${s.id}${kind} | ${s.ops.map((o) => `\`${o}\``).join(', ')} | ${s.call} | ${s.why} | ${s.removedIn} | ${v ? [...v].sort().join(', ') : '—'} |`);
  }
  lines.push(
    '',
    'Shim-derived view fields (runner bookkeeping, also not parity): `window.period`, `state`, `tallyRound`, `roundRejected`, `branch` and `matchedUnits`. Every auction and holder field comes from the engine (S2).',
  );
  const notRun = reports.flatMap((r) => r.notRun);
  if (notRun.length) {
    lines.push('', '## Not replayed on the merces backend', '');
    for (const n of notRun) lines.push(`- ${n.vector}: ${describeExpected(n.expected)}`);
  }
  if (extra.sections?.length) lines.push('', ...extra.sections);
  return lines.join('\n') + '\n';
}

/**
 * Write `VECTOR_PARITY.md` into `outDir`, with optional sections after the results (the sync step adds our S3 claim
 * scenarios) and an appendix (the sync step's op inventory).
 */
export function writeParity(outDir: string, reports: readonly RunReport[], source: ParitySource, extra: { notes?: string[]; sections?: string[]; appendix?: string[] } = {}): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'VECTOR_PARITY.md');
  const body = renderParity(reports, source, { ...(extra.notes ? { notes: extra.notes } : {}), ...(extra.sections ? { sections: extra.sections } : {}) });
  writeFileSync(file, body + (extra.appendix?.length ? '\n' + extra.appendix.join('\n') + '\n' : ''));
  return file;
}

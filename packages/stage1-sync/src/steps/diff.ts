import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stage1Path } from '@merces/chains';
import { adminCommands, eventPayloads, routerCommands, serviceCommands, userCommands } from '@merces/domain';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';

/**
 * Step 3: diff Stage 1's events and instructions against the canonical vocabulary and write INTERFACE_DRIFT.md.
 * Accepted inputs: a JSON schema file shaped like ours ({events: {Name: {properties}}, commands: {...}}), or
 * the generated IDL/ABI modules (event and instruction names only). Nothing is papered over: every
 * canonical item without a counterpart, every extra Stage 1 item and every field mismatch is listed.
 * Only exact matches (case, '_' and '-' ignored) count as mappings; a substring look-alike is listed as an
 * unverified match and counts as drift, as do extra fields/args and items whose fields are unknown.
 */
export async function diffInterfaces(ctx: StepCtx): Promise<StepReport> {
  const details: string[] = [];
  const m = ctx.location.manifest;
  const schemaPath = stage1Path(ctx.location, m.events?.schema);
  const stage1Events = new Map<string, Set<string> | null>();
  const stage1Commands = new Map<string, Set<string> | null>();
  let source = 'none';
  const conflicts: string[] = [];
  /**
   * Record an item seen in one source. Sources never overwrite each other: a names-only source (an IDL without the
   * schema file) leaves the item unverified even when another source has fields, and two sources that disagree on
   * the field set (two chains, or two ABIs with the same function name) make it unverified and are listed.
   */
  const put = (map: Map<string, Set<string> | null>, name: string, fields: Set<string> | null): void => {
    if (!map.has(name)) {
      map.set(name, fields);
      return;
    }
    const prev = map.get(name) ?? null;
    if (prev === null || fields === null) {
      map.set(name, null);
      return;
    }
    const same = prev.size === fields.size && [...prev].every((f) => fields.has(f));
    if (!same) {
      conflicts.push(`${name}: sources disagree on fields ({${[...prev].join(', ')}} vs {${[...fields].join(', ')}})`);
      map.set(name, null);
    }
  };

  if (schemaPath && existsSync(schemaPath)) {
    source = schemaPath;
    const raw = JSON.parse(readFileSync(schemaPath, 'utf8')) as { events?: Record<string, { properties?: Record<string, unknown> }>; commands?: Record<string, { properties?: Record<string, unknown> }> };
    for (const [n, s] of Object.entries(raw.events ?? {})) stage1Events.set(n, s.properties ? new Set(Object.keys(s.properties)) : null);
    for (const [n, s] of Object.entries(raw.commands ?? {})) stage1Commands.set(n, s.properties ? new Set(Object.keys(s.properties)) : null);
  } else {
    // fall back to names from the generated modules
    source = 'generated clients (names only)';
    const genSol = join(ctx.generatedDir, 'solana');
    const genEvm = join(ctx.generatedDir, 'evm');
    if (existsSync(genSol)) {
      for (const f of (await import('node:fs')).readdirSync(genSol).filter((x) => x.endsWith('.ts') && x !== 'index.ts')) {
        const src = readFileSync(join(genSol, f), 'utf8');
        for (const mm of src.matchAll(/^  (\w+): \{ discriminator/gm)) {
          const name = mm[1]!;
          if (src.indexOf(`export const events = {`) < src.indexOf(mm[0]) && src.indexOf(mm[0]) < src.indexOf('export const accounts')) put(stage1Events, name, null);
          else if (src.indexOf(mm[0]) < src.indexOf('export const events')) put(stage1Commands, name, null);
        }
      }
    }
    if (existsSync(genEvm)) {
      for (const f of (await import('node:fs')).readdirSync(genEvm).filter((x) => x.endsWith('.ts') && x !== 'index.ts')) {
        const abi = JSON.parse(readFileSync(join(genEvm, f), 'utf8').replace(/^[^[]*/, '').replace(/ as const;\s*$/, '')) as { type: string; name?: string; stateMutability?: string; inputs?: { name: string }[] }[];
        for (const item of abi) {
          if (item.type === 'event' && item.name) put(stage1Events, item.name, new Set((item.inputs ?? []).map((i) => i.name)));
          // view and pure functions are reads, not instructions: only state-changing functions are compared
          if (item.type === 'function' && item.name && item.stateMutability !== 'view' && item.stateMutability !== 'pure') put(stage1Commands, item.name, new Set((item.inputs ?? []).map((i) => i.name)));
        }
      }
    }
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const findCounterpart = (name: string, pool: Iterable<string>): { key: string; exact: boolean } | null => {
    const n = norm(name);
    const keys = [...pool];
    for (const k of keys) if (norm(k) === n) return { key: k, exact: true };
    for (const k of keys) if (norm(k).includes(n) || n.includes(norm(k))) return { key: k, exact: false };
    return null;
  };
  /** Field-by-field comparison; returns mapping and drift lines and the number of drift items. */
  const compareFields = (ours: string[], theirs: Set<string>, noun: 'field' | 'arg'): { mapping: string[]; drift: string[]; count: number } => {
    const mapping: string[] = [];
    const drift: string[] = [];
    const used = new Set<string>();
    for (const f of ours) {
      const c = findCounterpart(f, theirs);
      if (!c) drift.push(`missing ${noun} ${f}`);
      else if (!c.exact) {
        used.add(c.key);
        drift.push(`unverified match ${f}←${c.key}`);
      } else {
        used.add(c.key);
        mapping.push(`${f}←${c.key}`);
      }
    }
    for (const t of theirs) if (!used.has(t) && !ours.some((f) => norm(f) === norm(t))) drift.push(`extra ${noun} ${t}`);
    return { mapping, drift, count: drift.length };
  };

  const md: string[] = ['# INTERFACE_DRIFT.md', '', `Generated by stage1:sync from ${source}.`, '', '## Events', '', '| Canonical event | Stage 1 counterpart | Field mapping | Drift |', '| --- | --- | --- | --- |'];
  let missing = 0;
  let mismatched = 0;
  let unverified = 0;
  let extra = 0;
  const matchedStage1 = new Set<string>();
  for (const [name, schema] of Object.entries(eventPayloads)) {
    const ours = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
    const found = findCounterpart(name, stage1Events.keys());
    if (!found) {
      missing++;
      md.push(`| ${name} | **missing** | — | Stage 1 emits no counterpart; adapter must synthesise or the model must change (record why) |`);
      continue;
    }
    const counterpart = found.key;
    matchedStage1.add(counterpart);
    const nameDrift = found.exact ? [] : [`unverified name match ${name}←${counterpart}`];
    if (!found.exact) unverified++;
    const theirs = stage1Events.get(counterpart);
    if (!theirs) {
      unverified++;
      md.push(`| ${name} | ${counterpart} | fields unknown (names only) | ${[...nameDrift, 'verify field-by-field by hand'].join('; ')} |`);
      continue;
    }
    const { mapping, drift, count } = compareFields(ours, theirs, 'field');
    mismatched += count;
    md.push(`| ${name} | ${counterpart} | ${mapping.join(', ') || '—'} | ${[...nameDrift, ...drift].join('; ') || 'none'} |`);
  }
  for (const k of stage1Events.keys()) {
    if (matchedStage1.has(k)) continue;
    extra++;
    md.push(`| — | ${k} | — | extra Stage 1 event, not in the canonical model |`);
  }

  md.push('', '## Commands', '', '| Canonical command | Stage 1 counterpart | Field mapping | Drift |', '| --- | --- | --- | --- |');
  const matchedCmd = new Set<string>();
  for (const group of [userCommands, serviceCommands, adminCommands, routerCommands]) {
    for (const [name, schema] of Object.entries(group)) {
      const ours = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape).filter((k) => k !== 'kind');
      const found = findCounterpart(name, stage1Commands.keys());
      if (!found) {
        missing++;
        md.push(`| ${name} | **missing** | — | no Stage 1 instruction/function found |`);
        continue;
      }
      const counterpart = found.key;
      matchedCmd.add(counterpart);
      const nameDrift = found.exact ? [] : [`unverified name match ${name}←${counterpart}`];
      if (!found.exact) unverified++;
      const theirs = stage1Commands.get(counterpart);
      if (!theirs) {
        unverified++;
        md.push(`| ${name} | ${counterpart} | fields unknown | ${[...nameDrift, 'verify by hand'].join('; ')} |`);
        continue;
      }
      const { mapping, drift, count } = compareFields(ours, theirs, 'arg');
      mismatched += count;
      md.push(`| ${name} | ${counterpart} | ${mapping.join(', ') || '—'} | ${[...nameDrift, ...drift].join('; ') || 'none'} |`);
    }
  }
  for (const k of stage1Commands.keys()) {
    if (matchedCmd.has(k)) continue;
    extra++;
    md.push(`| — | ${k} | — | extra Stage 1 instruction, not in the canonical model |`);
  }
  if (conflicts.length) md.push('', '## Sources that disagree', '', ...conflicts.map((c) => `- ${c}`));

  writeFileSync(ctx.driftFile ?? 'INTERFACE_DRIFT.md', md.join('\n') + '\n');
  writeFileSync(join(ctx.outDir, 'INTERFACE_DRIFT.md'), md.join('\n') + '\n');
  // every kind of unresolved drift keeps the step from 'ok' (A-SYNC-1), extra Stage 1 items included
  const status: StepReport['status'] = stage1Events.size === 0 && stage1Commands.size === 0 ? 'fail' : missing + mismatched + unverified + extra > 0 ? 'warn' : 'ok';
  details.push(`${missing} canonical item(s) without counterpart, ${mismatched} field mismatch(es), ${unverified} unverified match(es), ${extra} extra Stage 1 item(s); ${stage1Events.size} Stage 1 events, ${stage1Commands.size} instructions/functions seen`);
  for (const c of conflicts) details.push(`conflict: ${c}`);
  return { step: 'diff', status, summary: status === 'fail' ? 'no Stage 1 interface information found' : 'INTERFACE_DRIFT.md written', details };
}

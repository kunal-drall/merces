#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parse } = createRequire(resolve(root, 'packages/api/package.json'))('yaml');
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const stable = (v) => JSON.stringify(normalize(v));
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  return v;
}
function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (METHODS.has(method)) out.set(`${method.toUpperCase()} ${path}`, { operation, parameters: item.parameters, servers: item.servers, security: doc.security });
    }
  }
  return out;
}
function fields(doc) {
  const out = new Map();
  const visit = (schema, prefix, seen = new Set()) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.$ref?.startsWith('#/components/schemas/')) {
      const name = schema.$ref.slice('#/components/schemas/'.length);
      if (!seen.has(name)) visit(doc.components?.schemas?.[name], prefix, new Set([...seen, name]));
    }
    for (const part of schema.allOf ?? []) visit(part, prefix, seen);
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      const key = `${prefix}.${name}`;
      const old = out.get(key);
      out.set(key, { schema: { ...old?.schema, ...value }, required: !!old?.required || (schema.required ?? []).includes(name) });
      visit(value, key, seen);
      if (value.items) visit(value.items, `${key}[]`, seen);
    }
  };
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) visit(schema, name, new Set([name]));
  return out;
}
function changes(a, b) {
  const added = [], removed = [], changed = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(key)) added.push(key);
    else if (!b.has(key)) removed.push(key);
    else if (stable(a.get(key)) !== stable(b.get(key))) changed.push(key);
  }
  return { added, removed, changed };
}
function fieldType(value) {
  const s = value.schema;
  return `${Array.isArray(s.type) ? s.type.join('|') : s.type ?? s.$ref ?? (s.oneOf ? 'oneOf' : s.anyOf ? 'anyOf' : 'unspecified')}${value.required ? ' (required)' : ' (optional)'}`;
}
export function renderChangelog(before, after, from = 'before', to = 'after') {
  const op = changes(operations(before), operations(after));
  const a = fields(before), b = fields(after), field = changes(a, b);
  const lines = [`## ${from} → ${to}`, ''];
  for (const [label, items] of [['Operations added', op.added], ['Operations removed', op.removed], ['Operations changed', op.changed], ['Component fields added', field.added], ['Component fields removed', field.removed]]) {
    if (items.length) lines.push(`### ${label}`, '', ...items.map((key) => `- \`${key}\``), '');
  }
  if (field.changed.length) lines.push('### Component fields changed / retyped', '', ...field.changed.map((key) => `- \`${key}\`: ${fieldType(a.get(key))} → ${fieldType(b.get(key))}; schema constraints or metadata changed.`), '');
  if (!Object.values(op).flat().length && !Object.values(field).flat().length) lines.push('No operation or component-field changes.', '');
  return lines.join('\n');
}
export function readRevision(revision, cwd = root) {
  // Resolve first: an option-looking revision is never interpreted as a git flag, and the show argument is a hash.
  const hash = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  return parse(execFileSync('git', ['show', `${hash}:packages/api/openapi.yaml`], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to, ...extra] = process.argv.slice(2);
  if (!from || !to || extra.length) { process.stderr.write('usage: pnpm api:changelog <from-rev> <to-rev>\n'); process.exitCode = 2; }
  else {
    try { process.stdout.write(renderChangelog(readRevision(from), readRevision(to), from, to)); }
    catch (error) { process.stderr.write(`api:changelog: ${error.message}\n`); process.exitCode = 1; }
  }
}

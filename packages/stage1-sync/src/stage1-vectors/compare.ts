/**
 * `expect` comparison (S1 plan §5.2; Stage 1 SIM:503-513).
 *
 * Only the top-level keys the step carries are compared, other than `op`, `series`, `t` and `note`. Each is compared
 * as a whole value: nested objects must have equal key sets at every level (so `balances` and `holders` list exactly
 * the expected names), arrays equal lengths, leaves equal JSON values. Stage 1 compares `JSON.stringify` strings, which
 * is key-order sensitive; this comparison is not (it canonicalises key order), and otherwise agrees.
 */

/** Step keys that are not expectations. */
export const NON_EXPECT_KEYS = new Set(['op', 'series', 't', 'note']);

/** One leaf (or key-set) difference; `path` is dotted (`balances.b1.stable`, `ledger.status`). */
export interface Diff {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Marks a key that exists on one side only. */
export const ABSENT = '<absent>';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON view of a value (bigint → decimal string; undefined stays undefined). */
export function toJsonValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)));
}

function diffValues(expected: unknown, actual: unknown, path: string, out: Diff[]): void {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const k of keys) {
      const p = `${path}.${k}`;
      if (!(k in actual)) out.push({ path: p, expected: expected[k], actual: ABSENT });
      else if (!(k in expected)) out.push({ path: p, expected: ABSENT, actual: actual[k] });
      else diffValues(expected[k], actual[k], p, out);
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return;
    }
    expected.forEach((e, i) => diffValues(e, actual[i], `${path}[${i}]`, out));
    return;
  }
  if (expected !== actual) out.push({ path, expected, actual });
}

/** Differences between an `expect` step and a world's snapshot (empty when they match). */
export function compareExpect(step: Record<string, unknown>, snapshot: Record<string, unknown>): Diff[] {
  const ex = toJsonValue(step) as Record<string, unknown>;
  const ac = toJsonValue(snapshot) as Record<string, unknown>;
  const out: Diff[] = [];
  for (const k of Object.keys(ex).sort()) {
    if (NON_EXPECT_KEYS.has(k)) continue;
    if (!(k in ac)) out.push({ path: k, expected: ex[k], actual: ABSENT });
    else diffValues(ex[k], ac[k], k, out);
  }
  return out;
}

/** The `fx` request an `expect` step implies (pair → the periods it lists), as Stage 1 builds it (SIM:504). */
export function fxRequestOf(step: Record<string, unknown>): Record<string, number[]> | undefined {
  const fx = step.fx;
  if (!isPlainObject(fx)) return undefined;
  return Object.fromEntries(Object.entries(fx).map(([pair, v]) => [pair, Object.keys(isPlainObject(v) && isPlainObject(v.quarters) ? v.quarters : {}).map(Number)]));
}

/** A value as one short line for a report (public values only reach here). */
export function brief(v: unknown, max = 160): string {
  if (v === ABSENT) return ABSENT;
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

import type { Pool } from 'pg';

/**
 * `sim:reset` (S1 plan D6, amendment M3): discard persisted simulator chains and everything keyed to them, so a new
 * simulator state layout (version 5 since S4) starts from an empty chain. Simulator states are never upgraded in place.
 *
 * For the named simulator chains only (never TRUNCATE, never another chain's rows), in one transaction:
 * - the simulator state and event log (`sim_state`, `sim_events`, key `<prefix>:<chain>`);
 * - the indexer's projections and cursor for those chains (every chain-keyed read-model table);
 * - the off-chain rows keyed by those chains' series ids: every table with a `series_id` column (series drafts, the
 *   terms vault, reports, tier-3 cases, hardship requests, …), plus the reminders, notifications, outbox and jobs
 *   that name such a series, and the attestor proposals and FX fallback requests of those chains.
 * Series ids are deterministic (`<chain>:<address>`, derived from the issuer and a counter), so a row left behind
 * would re-attach to a new series with the same id.
 *
 * People and paper records that are not tied to a series are kept (accounts, wallets, applications, eligibility,
 * contract sessions, drafts that never created a series). The chain's own registrations lived in the simulator
 * state and are gone: the allowlist, attestors, verifier keys and issuers must be re-applied.
 *
 * Refuses a chain that has no persisted simulator state under the prefix (a live chain's projections share the chain
 * key) and a chain another process has open (the API or `pnpm dev:mock` hold its single-writer lock).
 */

/** Read-model and per-chain tables whose rows carry the chain key in a `chain` column. */
export const SIM_RESET_CHAIN_TABLES = [
  'indexer_cursors', 'events', 'events_pending', 'issuers', 'series', 'money_events', 'fees_ledger', 'status_history', 'rate_snapshots', 'fx_fallbacks',
  'allowlist', 'attestors', 'activity', 'attestor_proposals', 'fx_fallback_requests',
] as const;

/** What has to be redone on each reset chain, printed by the CLI. */
export const SIM_RESET_REAPPLY = [
  'allowlist entries (setAllowlist for every approved wallet)',
  'attestor keys (registerAttestor; revoked keys and their revocation times are gone too)',
  'report-verifier keys (registerVerifierKey)',
  'issuer registrations (registerIssuer)',
] as const;

export interface SimResetOptions {
  /** the persistence key prefix (`MERCES_SIM_KEY`; default `sim`) */
  prefix?: string;
  /** chain keys to reset; default every chain with a persisted simulator state under the prefix */
  chains?: string[];
  /** count what would be deleted, then roll back */
  dryRun?: boolean;
}

export interface SimResetReport {
  schema: string;
  dryRun: boolean;
  chains: string[];
  /** rows deleted per table, tables with none left out */
  deleted: { table: string; rows: number }[];
  /** series drafts on those chains that never created a series (kept) */
  draftsKept: number;
}

export class SimResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimResetError';
  }
}

/** The CLI's guard: the reset deletes data, so it runs only when `MERCES_ALLOW_SIM_RESET=1`. */
export function simResetAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERCES_ALLOW_SIM_RESET === '1';
}

export async function resetSimulatorChains(pool: Pool, opts: SimResetOptions = {}): Promise<SimResetReport> {
  const prefix = opts.prefix ?? 'sim';
  const c = await pool.connect();
  try {
    await c.query('begin');
    const schema = (await c.query<{ s: string }>('select current_schema() as s')).rows[0]!.s;
    const columns = await c.query<{ table_name: string; column_name: string }>('select table_name, column_name from information_schema.columns where table_schema = $1', [schema]);
    const tables = new Map<string, Set<string>>();
    for (const r of columns.rows) {
      const t = tables.get(r.table_name) ?? new Set<string>();
      t.add(r.column_name);
      tables.set(r.table_name, t);
    }
    const id = (x: string): string => `"${x.replace(/"/g, '""')}"`;
    const q = (t: string): string => `${id(schema)}.${id(t)}`;
    const has = (t: string, col?: string): boolean => !!tables.get(t) && (!col || tables.get(t)!.has(col));

    // which chains are simulator chains under this prefix
    const known = has('sim_state', 'key')
      ? (await c.query<{ key: string }>(`select key from ${q('sim_state')} where starts_with(key, $1) order by key`, [`${prefix}:`])).rows.map((r) => r.key.slice(prefix.length + 1))
      : [];
    const chains = opts.chains ?? known;
    for (const ch of chains) {
      if (!known.includes(ch)) throw new SimResetError(`${ch} has no persisted simulator state under the key prefix "${prefix}" in schema ${schema}; only simulator chains are reset (simulator chains here: ${known.join(', ') || 'none'})`);
    }
    const report: SimResetReport = { schema, dryRun: !!opts.dryRun, chains: [...chains], deleted: [], draftsKept: 0 };
    if (!chains.length) {
      await c.query('rollback');
      return report;
    }
    // the process that owns a persisted chain holds pg_try_advisory_lock(hashtext('merces-sim:<key>')) (persistence.ts)
    for (const ch of chains) {
      const r = await c.query<{ ok: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as ok', [`merces-sim:${prefix}:${ch}`]);
      if (!r.rows[0]?.ok) throw new SimResetError(`simulator chain ${prefix}:${ch} is open in another process (the API or pnpm dev:mock): stop it first`);
    }

    const counts = new Map<string, number>();
    const del = async (table: string, sql: string, params: unknown[]): Promise<void> => {
      const r = await c.query(`delete from ${q(table)} where ${sql}`, params);
      if (r.rowCount) counts.set(table, (counts.get(table) ?? 0) + r.rowCount);
    };
    const keys = chains.map((ch) => `${prefix}:${ch}`);
    const seriesOf = (col: string): string => `exists (select 1 from unnest($1::text[]) as ch where starts_with(${col}, ch || ':'))`;

    // 1. the simulator state and event log
    if (has('sim_events', 'key')) await del('sim_events', 'key = any($1::text[])', [keys]);
    if (has('sim_state', 'key')) await del('sim_state', 'key = any($1::text[])', [keys]);

    // 2. per-chain projections and records
    for (const t of SIM_RESET_CHAIN_TABLES) if (has(t, 'chain')) await del(t, 'chain = any($1::text[])', [chains]);

    // 3. rows naming a series of those chains: terms_vault before series_drafts (foreign key), drafts last
    if (has('terms_vault', 'draft_id') && has('series_drafts', 'series_id')) {
      await del('terms_vault', `draft_id in (select draft_id from ${q('series_drafts')} where ${seriesOf('series_id')})`, [chains]);
    }
    const seriesTables = [...tables.entries()].filter(([, cols]) => cols.has('series_id')).map(([t]) => t).sort((a, b) => (a === 'series_drafts' ? 1 : b === 'series_drafts' ? -1 : a < b ? -1 : 1));
    for (const t of seriesTables) await del(t, seriesOf('series_id'), [chains]);
    if (has('reminders_sent', 'target')) await del('reminders_sent', seriesOf('target'), [chains]);
    if (has('notifications', 'data')) await del('notifications', seriesOf(`(data->>'seriesId')`), [chains]);
    if (has('outbox', 'payload')) await del('outbox', seriesOf(`(payload->>'seriesId')`), [chains]);
    if (has('jobs', 'payload')) await del('jobs', seriesOf(`(payload->>'seriesId')`), [chains]);

    if (has('series_drafts', 'chain')) {
      const r = await c.query<{ n: number }>(`select count(*)::int as n from ${q('series_drafts')} where chain = any($1::text[]) and series_id is null`, [chains]);
      report.draftsKept = r.rows[0]?.n ?? 0;
    }
    await c.query(opts.dryRun ? 'rollback' : 'commit');
    report.deleted = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([table, rows]) => ({ table, rows }));
    return report;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The CLI's printout: what was deleted and what must be re-applied. */
export function formatSimResetReport(r: SimResetReport, prefix: string): string {
  if (!r.chains.length) return `sim:reset: no persisted simulator chain under the key prefix "${prefix}" in schema ${r.schema}; nothing to do`;
  const lines = [`sim:reset${r.dryRun ? ' (dry run: nothing was deleted)' : ''}: ${r.dryRun ? 'would reset' : 'reset'} simulator chain(s) ${r.chains.join(', ')} (key prefix "${prefix}", schema ${r.schema})`, r.dryRun ? 'would delete:' : 'deleted:'];
  if (!r.deleted.length) lines.push('  (no rows)');
  for (const d of r.deleted) lines.push(`  ${d.table}: ${d.rows}`);
  lines.push(`kept: ${r.draftsKept} series draft(s) on these chains that never created a series; people, paper and audit records`);
  lines.push('re-apply on each reset chain (they lived in the simulator state):');
  for (const x of SIM_RESET_REAPPLY) lines.push(`  - ${x}`);
  return lines.join('\n');
}


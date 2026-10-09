import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { PgSimPersistence, SimStateVersionError, SimulatorChain } from '../src/index.ts';
import { SimResetError, formatSimResetReport, resetSimulatorChains, simResetAllowed } from '../src/reset.ts';
import { GENESIS } from './helpers.ts';

describe('sim:reset guard', () => {
  it('runs only with MERCES_ALLOW_SIM_RESET=1', () => {
    expect(simResetAllowed({})).toBe(false);
    expect(simResetAllowed({ MERCES_ALLOW_SIM_RESET: 'true' })).toBe(false);
    expect(simResetAllowed({ MERCES_ALLOW_SIM_RESET: '1' })).toBe(true);
  });
});

describe.skipIf(!dbTestsEnabled())('sim:reset (Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  let pool: Pool;
  // advisory locks are database-wide: a prefix of our own keeps parallel suites' simulator chains out of the way
  const prefix = `rst${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    t = await createTestSchema();
    pool = t.pool;
  });
  afterAll(async () => {
    await t?.drop();
  });

  async function persisted(chainKey: string): Promise<SimulatorChain> {
    return SimulatorChain.create({ personality: chainKey === 'monad' ? 'monad' : 'solana', chainKey, genesis: GENESIS, persistence: new PgSimPersistence(pool, `${prefix}:${chainKey}`) });
  }
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query<{ n: string }>(`select count(*) as n from ${sql}`, params)).rows[0]!.n);

  async function seedOffchain(chain: string): Promise<void> {
    const sid = `${chain}:series-a`;
    await pool.query("insert into events (chain, cursor, seq, block_time, block_ref, tx_id, type, series_id, payload) values ($1, '000000000001', 1, 1, '1', 'tx', 'SeriesCreated', $2, '{}')", [chain, sid]);
    await pool.query('insert into indexer_cursors (chain, cursor, last_seq) values ($1, $2, 1)', [chain, '000000000001']);
    await pool.query("insert into attestors (chain, attestor, active) values ($1, 'att', true)", [chain]);
    await pool.query(
      "insert into reports (report_id, series_id, period_id, account_id, tier, source, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof) values ($1, $2, '2026Q1', 'acct-1', 2, 'stripe', 0, '0x00', '0x00', 'unity', 1, '{}')",
      [`rep-${chain}`, sid],
    );
    await pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, series_id, state) values ($1, 'acct-1', $2, 'iss', '{}', $3, 'created')", [`draft-${chain}`, chain, sid]);
    await pool.query("insert into terms_vault (draft_id, series_id, ciphertext, key_id, commitment) values ($1, null, 'ct', 'k1', '0x00')", [`draft-${chain}`]);
    await pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, state) values ($1, 'acct-1', $2, 'iss', '{}', 'terms_set')", [`open-draft-${chain}`, chain]);
    await pool.query("insert into reminders_sent (kind, target, recipient) values ('report-due', $1, 'iss')", [`${sid}:2026Q1`]);
    await pool.query("insert into outbox (topic, payload) values ('notification', $1)", [JSON.stringify({ kind: 'payout.available', seriesId: sid })]);
    await pool.query("insert into notifications (notification_id, account_id, kind, subject, body, data, payload_hash) values ($1, 'acct-1', 'payout.available', 's', 'b', $2, $1)", [`n-${chain}`, JSON.stringify({ seriesId: sid })]);
  }

  it('deletes only the named simulator chains and the rows keyed to their series, keeping people and paper', async () => {
    await pool.query("insert into accounts (account_id) values ('acct-1')");
    for (const key of ['solana', 'monad']) {
      const sim = await persisted(key);
      await sim.fund(sim.address('wallet:x'), 'USDC', 5n);
      await sim.close();
      await seedOffchain(key);
    }
    await pool.query("insert into outbox (topic, payload) values ('notification', $1)", [JSON.stringify({ kind: 'application.submitted', accountId: 'acct-1' })]);

    const dry = await resetSimulatorChains(pool, { prefix, chains: ['solana'], dryRun: true });
    expect(dry.deleted.find((d) => d.table === 'sim_state')?.rows).toBe(1);
    expect(formatSimResetReport(dry, prefix)).toMatch(/dry run: nothing was deleted/);
    expect(await count('sim_state where key = $1', [`${prefix}:solana`])).toBe(1);
    expect(await count("events where chain = 'solana'")).toBe(1);

    const report = await resetSimulatorChains(pool, { prefix, chains: ['solana'] });
    expect(report.chains).toEqual(['solana']);
    expect(report.draftsKept).toBe(1);
    const deleted = Object.fromEntries(report.deleted.map((d) => [d.table, d.rows]));
    expect(deleted).toMatchObject({ sim_state: 1, events: 1, indexer_cursors: 1, reports: 1, series_drafts: 1, terms_vault: 1, reminders_sent: 1, outbox: 1, notifications: 1 });
    expect(formatSimResetReport(report, prefix)).toMatch(/re-apply on each reset chain[\s\S]*registerAttestor[\s\S]*registerVerifierKey/);

    // the reset chain is gone, the other untouched
    expect(await count('sim_state where key = $1', [`${prefix}:solana`])).toBe(0);
    expect(await count('sim_events where key = $1', [`${prefix}:solana`])).toBe(0);
    expect(await count('sim_state where key = $1', [`${prefix}:monad`])).toBe(1);
    for (const table of ['events', 'indexer_cursors', 'attestors']) {
      expect(await count(`${table} where chain = 'solana'`), table).toBe(0);
      expect(await count(`${table} where chain = 'monad'`), table).toBe(1);
    }
    expect(await count("reports where series_id like 'monad:%'")).toBe(1);
    expect(await count("reports where series_id like 'solana:%'")).toBe(0);
    // people and paper not tied to a series stay
    expect(await count('accounts')).toBe(1);
    expect(await count("series_drafts where chain = 'solana' and series_id is null")).toBe(1);
    expect(await count("outbox where payload->>'kind' = 'application.submitted'")).toBe(1);
    expect(await count("notifications where data->>'seriesId' like 'monad:%'")).toBe(1);

    // a reset chain starts again from an empty version-2 state
    const fresh = await persisted('solana');
    expect(fresh.state.version).toBe(2);
    expect(await fresh.getBalance(fresh.address('wallet:x'), 'USDC')).toBe('0');
    await fresh.close();
  });

  it('refuses a chain that is open in another process, and a chain with no simulator state', async () => {
    const open = await persisted('monad');
    try {
      await expect(resetSimulatorChains(pool, { prefix, chains: ['monad'] })).rejects.toThrow(SimResetError);
      await expect(resetSimulatorChains(pool, { prefix, chains: ['monad'] })).rejects.toThrow(/open in another process/);
    } finally {
      await open.close();
    }
    await expect(resetSimulatorChains(pool, { prefix, chains: ['base-sepolia'] })).rejects.toThrow(/no persisted simulator state/);
    expect(await count('sim_state where key = $1', [`${prefix}:monad`])).toBe(1);
  });

  it('a version-1 state is refused at load, the chain lock is released, and the reset clears it', async () => {
    await pool.query('insert into sim_state (key, state, clock) values ($1, $2, 0)', [`${prefix}:old`, JSON.stringify({ config: {}, series: { $map: [] } })]);
    await expect(persisted('old')).rejects.toThrow(SimStateVersionError);
    const report = await resetSimulatorChains(pool, { prefix, chains: ['old'] });
    expect(report.deleted).toContainEqual({ table: 'sim_state', rows: 1 });
    // with no chains named, every simulator chain under the prefix is reset
    const all = await resetSimulatorChains(pool, { prefix });
    expect(all.chains.sort()).toEqual(['monad', 'solana']);
    expect(await count('sim_state where starts_with(key, $1)', [`${prefix}:`])).toBe(0);
    const none = await resetSimulatorChains(pool, { prefix });
    expect(none.chains).toEqual([]);
    expect(formatSimResetReport(none, prefix)).toMatch(/nothing to do/);
  });
});

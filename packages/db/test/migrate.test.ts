import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, createPool, databaseUrl, dbTestsEnabled, migrate } from '../src/index.ts';

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

async function withFreshSchema(fn: (schema: string) => Promise<void>): Promise<void> {
  const schema = `t_mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  await admin.query(`create schema ${schema}`);
  try {
    await fn(schema);
  } finally {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

describe.skipIf(!dbTestsEnabled())('migrate', () => {
  it('serialises concurrent processes: three migrate() calls on a fresh schema all succeed, each file applied once', async () => {
    await withFreshSchema(async (schema) => {
      // separate pools stand in for separate processes booting together
      const pools = [0, 1, 2].map(() => createPool(databaseUrl(), schema));
      try {
        const results = await Promise.allSettled(pools.map((p) => migrate(p)));
        for (const r of results) expect(r.status, r.status === 'rejected' ? String(r.reason) : '').toBe('fulfilled');
        const applied = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        expect(applied.sort()).toEqual(files);
        const rows = await pools[0]!.query<{ name: string }>('select name from schema_migrations order by name');
        expect(rows.rows.map((r) => r.name)).toEqual(files);
        expect(await migrate(pools[0]!)).toEqual([]);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  it('releases the lock and the client after a failed migration', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig-'));
        writeFileSync(join(dir, '001_ok.sql'), 'create table mig_ok (id int);');
        writeFileSync(join(dir, '002_bad.sql'), 'create table mig_bad (id int); select no_such_function();');
        await expect(migrate(pool, dir)).rejects.toThrow(/migration 002_bad.sql failed/);
        // the failed file rolled back; a retry is not blocked by a leaked lock
        const t = await pool.query("select to_regclass('mig_bad') as bad, to_regclass('mig_ok') as ok");
        expect(t.rows[0]).toMatchObject({ bad: null, ok: 'mig_ok' });
        writeFileSync(join(dir, '002_bad.sql'), 'create table mig_bad (id int);');
        expect(await migrate(pool, dir)).toEqual(['002_bad.sql']);
        expect(pool.idleCount + pool.waitingCount).toBe(pool.totalCount);
      } finally {
        await pool.end();
      }
    });
  });

  // S4 WP5 (cause S4-REG; amendment fix 2): migration 023 on a database seeded before it: the registry's new columns get
  // values for the rows already there, the request kinds check takes the registry's commands, and the boolean
  // requests stored before S4 are re-expressed once in the registry's vocabulary
  it('023_key_registry on a seeded pre-S4 database: existing rows keep their state and satisfy the new constraints', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig023-'));
        for (const f of files.filter((x) => x < '023')) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        await migrate(pool, dir);
        await pool.query("insert into attestors (chain, attestor, active) values ('solana', 'att-on', true), ('solana', 'att-off', false)");
        const req = (id: string, command: Record<string, unknown>, state = 'proposed') =>
          pool.query("insert into admin_tx_requests (request_id, kind, chain, command, state, created_by) values ($1, $2, 'solana', $3, $4, 'adm')", [id, command.kind, JSON.stringify(command), state]);
        await req('r-on', { kind: 'registerAttestor', attestor: 'att-on', active: true }, 'confirmed');
        await req('r-off', { kind: 'registerAttestor', attestor: 'att-off', active: false }, 'sent');
        await req('r-vk', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true });
        // before 023 the registry's commands are refused by the kinds check
        await expect(pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ('x', 'revokeAttestor', 'solana', '{}', 'adm')")).rejects.toThrow(/admin_tx_requests_kind_check/);

        copyFileSync(join(MIGRATIONS_DIR, '023_key_registry.sql'), join(dir, '023_key_registry.sql'));
        expect(await migrate(pool, dir)).toEqual(['023_key_registry.sql']);
        // existing attestor rows: their state kept, no registry times, updated_seq 0 so any later event overwrites them
        const rows = await pool.query('select attestor, active, registered_at, revoked_at, updated_seq::int as updated_seq from attestors order by attestor');
        expect(rows.rows).toEqual([
          { attestor: 'att-off', active: false, registered_at: null, revoked_at: null, updated_seq: 0 },
          { attestor: 'att-on', active: true, registered_at: null, revoked_at: null, updated_seq: 0 },
        ]);
        // the boolean requests, re-expressed once: active=false is the revocation it now is, active=true a registration
        const reqs = await pool.query('select request_id, kind, command, state from admin_tx_requests order by request_id');
        expect(reqs.rows).toEqual([
          { request_id: 'r-off', kind: 'revokeAttestor', command: { kind: 'revokeAttestor', attestor: 'att-off' }, state: 'sent' },
          { request_id: 'r-on', kind: 'registerAttestor', command: { kind: 'registerAttestor', attestor: 'att-on' }, state: 'confirmed' },
          { request_id: 'r-vk', kind: 'registerVerifierKey', command: { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, state: 'proposed' },
        ]);
        // the registry's commands are accepted now, for both key kinds; anything else still is not
        for (const kind of ['revokeAttestor', 'rotateAttestor', 'revokeVerifierKey', 'rotateVerifierKey']) {
          await pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ($1, $2, 'solana', '{}', 'adm')", [`k-${kind}`, kind]);
        }
        await expect(pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ('bad', 'deactivateAttestor', 'solana', '{}', 'adm')")).rejects.toThrow(/admin_tx_requests_kind_check/);
        // a new row needs no updated_seq of its own
        await pool.query("insert into attestors (chain, attestor, active) values ('monad', 'att-new', true)");
        expect((await pool.query("select updated_seq::int as s from attestors where attestor = 'att-new'")).rows[0].s).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });

  // S4 WP6 (cause S4-T2): migration 024 on a database seeded at 023: the verifier keys' read model, the ed25519 verifier
  // key requests no chain can carry removed, and the reports holding a retired ed25519 attestation that were not yet
  // submitted superseded (no other report touched)
  it('024_verifier_keys on a database seeded at 023: the read model, the legacy verifier-key requests and the unsubmitted ed25519 reports', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig024-'));
        for (const f of files.filter((x) => x < '024')) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        await migrate(pool, dir);
        const req = (id: string, command: Record<string, unknown>, state: string) =>
          pool.query("insert into admin_tx_requests (request_id, kind, chain, command, state, created_by) values ($1, $2, 'solana', $3, $4, 'adm')", [id, command.kind, JSON.stringify(command), state]);
        await req('vk-old-proposed', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, 'proposed');
        await req('vk-old-confirmed', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, 'confirmed');
        await req('vk-new', { kind: 'registerVerifierKey', key: '0x' + '11'.repeat(20) }, 'proposed');
        await req('att', { kind: 'registerAttestor', attestor: 'a' }, 'confirmed');
        const ed = { keyId: 'k', seriesId: 'solana:x', periodId: '2026Q1', priorIncomeCommitment: '0x00', incomeCommitment: '0x01', tier: 2, liquidityEvent: false, signature: '0x22' };
        const rep = (id: string, state: string, tier: number, attestation: unknown) =>
          pool.query(
            "insert into reports (report_id, series_id, period_id, account_id, tier, source, state, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof, attestation) values ($1, 'solana:x', '2026Q1', 'acct', $2, 'stripe', $3, 0, '0x01', '0x02', 'unity', 1, '{}', $4)",
            [id, tier, state, attestation === null ? null : JSON.stringify(attestation)],
          );
        await rep('r-assembled', 'assembled', 2, ed);
        await rep('r-rejected', 'rejected', 2, ed);
        await rep('r-accepted', 'accepted', 2, ed);
        await rep('r-paid', 'paid', 2, ed);
        await rep('r-new', 'assembled', 2, { signer: '0x' + '11'.repeat(20), signature: '0x' + '22'.repeat(65) });
        await rep('r-tier3', 'assembled', 3, null);

        copyFileSync(join(MIGRATIONS_DIR, '024_verifier_keys.sql'), join(dir, '024_verifier_keys.sql'));
        expect(await migrate(pool, dir)).toEqual(['024_verifier_keys.sql']);
        expect((await pool.query('select request_id from admin_tx_requests order by request_id')).rows.map((r) => r.request_id)).toEqual(['att', 'vk-new']);
        const states = await pool.query('select report_id, state from reports order by report_id');
        expect(states.rows).toEqual([
          { report_id: 'r-accepted', state: 'accepted' },
          { report_id: 'r-assembled', state: 'superseded' },
          { report_id: 'r-new', state: 'assembled' },
          { report_id: 'r-paid', state: 'paid' },
          { report_id: 'r-rejected', state: 'superseded' },
          { report_id: 'r-tier3', state: 'assembled' },
        ]);
        // the read model: a 20-byte lowercase address per chain, updated_seq defaulting to 0
        await pool.query("insert into verifier_keys (chain, address, active) values ('solana', $1, true)", ['0x' + 'ab'.repeat(20)]);
        expect((await pool.query('select updated_seq::int as s, registered_at, revoked_at from verifier_keys')).rows).toEqual([{ s: 0, registered_at: null, revoked_at: null }]);
        for (const bad of ['0x' + 'AB'.repeat(20), '0x' + 'ab'.repeat(19), 'k']) {
          await expect(pool.query("insert into verifier_keys (chain, address, active) values ('monad', $1, true)", [bad])).rejects.toThrow(/verifier_keys_address_check/);
        }
      } finally {
        await pool.end();
      }
    });
  });
});

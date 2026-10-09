import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// bigint columns come back as strings (never floats); keep that.
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1700, (v) => v);

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/merces';
}

export function createPool(url: string = databaseUrl(), schema?: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 8, ...(schema ? { options: `-c search_path=${schema},public` } : {}) });
}

/** Advisory-lock class for migrations (two-key form, so it never collides with single-key locks elsewhere). */
const MIGRATE_LOCK_CLASS = 0x6d726373; // 'mrcs'

/**
 * Apply every migrations/*.sql not yet recorded in schema_migrations, in file order, each in a transaction.
 * Processes that boot together (api, keepers, indexer) all call this; a session advisory lock keyed on the
 * current schema serialises them, so the applied set is read only once the lock is held and no DDL runs twice.
 * Session locks belong to one connection, so the whole run uses a single client.
 */
export async function migrate(db: Queryable, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const owned = db instanceof pg.Pool;
  const c: pg.PoolClient = owned ? await db.connect() : (db as pg.PoolClient);
  let locked = false;
  try {
    await c.query("select pg_advisory_lock($1, hashtext(coalesce(current_schema(), '')))", [MIGRATE_LOCK_CLASS]);
    locked = true;
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const applied = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
        done.push(f);
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return done;
  } finally {
    let broken = false;
    if (locked) {
      await c.query("select pg_advisory_unlock($1, hashtext(coalesce(current_schema(), '')))", [MIGRATE_LOCK_CLASS]).catch(() => {
        broken = true;
      });
    }
    // a connection whose unlock failed may still hold the lock; destroy it rather than return it to the pool
    if (owned) c.release(broken);
  }
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Tests: a throwaway schema per test file so suites run in parallel against one database. */
export async function createTestSchema(url: string = databaseUrl()): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = createPool(url, schema);
  await migrate(pool);
  return {
    pool,
    schema,
    drop: async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}

/** Whether DB-backed tests should run (CI sets MERCES_TEST_DB=1; locally set DATABASE_URL). */
export function dbTestsEnabled(): boolean {
  return process.env.MERCES_TEST_DB === '1' || !!process.env.DATABASE_URL;
}

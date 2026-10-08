import type { Pool, PoolClient } from 'pg';
import type { DomainEvent } from '@merces/domain';
import { deserialiseState, serialiseState, type SimState } from './state.ts';

/** Persistent mode: the whole simulator state and event log live in Postgres so the backend (and Stage 3) can run against it for days. */
export interface SimPersistence {
  load(): Promise<{ state: SimState; events: DomainEvent[]; clock: number } | null>;
  save(state: SimState, events: DomainEvent[], clock: number, eventCount: number): Promise<void>;
  close?(): Promise<void>;
}

/**
 * One process owns a persisted simulator chain. Each process keeps the chain in memory and writes the whole state
 * back, so two writers on the same key would overwrite each other's state while their event logs interleave. `load()`
 * therefore takes a Postgres advisory lock on a dedicated connection and refuses to open a key another process holds;
 * the lock is released by `close()` or when the connection ends.
 */
export class PgSimPersistence implements SimPersistence {
  private savedEvents = 0;
  private owner: PoolClient | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly key: string,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      create table if not exists sim_state (key text primary key, state text not null, clock bigint not null, updated_at timestamptz not null default now());
      create table if not exists sim_events (key text not null, seq bigint not null, event jsonb not null, primary key (key, seq));
    `);
  }

  private async acquire(): Promise<void> {
    if (this.owner) return;
    const c = await this.pool.connect();
    const r = await c.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [`merces-sim:${this.key}`]);
    if (!r.rows[0]?.ok) {
      c.release();
      throw new Error(`simulator chain ${this.key} is already open in another process; run keepers and the indexer in-process (pnpm dev:mock) or give this process its own MERCES_SIM_KEY`);
    }
    this.owner = c;
  }

  async close(): Promise<void> {
    const c = this.owner;
    this.owner = null;
    if (!c) return;
    try {
      await c.query('select pg_advisory_unlock(hashtext($1))', [`merces-sim:${this.key}`]);
    } finally {
      c.release();
    }
  }

  async load(): Promise<{ state: SimState; events: DomainEvent[]; clock: number } | null> {
    await this.migrate();
    await this.acquire();
    const r = await this.pool.query<{ state: string; clock: string }>('select state, clock from sim_state where key = $1', [this.key]);
    const row = r.rows[0];
    if (!row) return null;
    const ev = await this.pool.query<{ event: DomainEvent }>('select event from sim_events where key = $1 order by seq', [this.key]);
    this.savedEvents = ev.rows.length;
    return { state: deserialiseState(row.state), events: ev.rows.map((x) => x.event), clock: Number(row.clock) };
  }

  async save(state: SimState, events: DomainEvent[], clock: number, _eventCount: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into sim_state (key, state, clock) values ($1, $2, $3) on conflict (key) do update set state = excluded.state, clock = excluded.clock, updated_at = now()', [this.key, serialiseState(state), clock]);
      for (let i = this.savedEvents; i < events.length; i++) {
        const e = events[i]!;
        await client.query('insert into sim_events (key, seq, event) values ($1, $2, $3) on conflict do nothing', [this.key, e.seq, JSON.stringify(e)]);
      }
      await client.query('commit');
      // only after the commit: a failed commit leaves these events to be written by the next save
      this.savedEvents = events.length;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async reset(): Promise<void> {
    await this.migrate();
    await this.pool.query('delete from sim_events where key = $1', [this.key]);
    await this.pool.query('delete from sim_state where key = $1', [this.key]);
    this.savedEvents = 0;
  }
}

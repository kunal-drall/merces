import type { Pool } from 'pg';
import type { DomainEvent } from '@merces/domain';
import { deserialiseState, serialiseState, type SimState } from './state.ts';

/** Persistent mode: the whole simulator state and event log live in Postgres so the backend (and Stage 3) can run against it for days. */
export interface SimPersistence {
  load(): Promise<{ state: SimState; events: DomainEvent[]; clock: number } | null>;
  save(state: SimState, events: DomainEvent[], clock: number, eventCount: number): Promise<void>;
}

export class PgSimPersistence implements SimPersistence {
  private savedEvents = 0;
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

  async load(): Promise<{ state: SimState; events: DomainEvent[]; clock: number } | null> {
    await this.migrate();
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
      this.savedEvents = events.length;
      await client.query('commit');
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

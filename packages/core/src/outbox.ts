import type { Queryable } from '@merces/db';

/** Outbox pattern: anything that leaves the database is written here in the same transaction and dispatched later. */
export async function enqueueOutbox(db: Queryable, topic: string, payload: Record<string, unknown>): Promise<number> {
  const r = await db.query<{ id: string }>('insert into outbox (topic, payload) values ($1, $2) returning id', [topic, JSON.stringify(payload)]);
  return Number(r.rows[0]!.id);
}

export type OutboxHandler = (topic: string, payload: Record<string, unknown>) => Promise<void>;

/** Dispatch pending outbox rows (oldest first). Safe to run concurrently and repeatedly: rows are locked with SKIP LOCKED. */
export async function dispatchOutbox(db: Queryable, handler: OutboxHandler, limit = 100): Promise<{ dispatched: number; failed: number }> {
  let dispatched = 0;
  let failed = 0;
  await db.query('begin');
  try {
    const rows = await db.query<{ id: string; topic: string; payload: Record<string, unknown>; attempts: number }>('select id, topic, payload, attempts from outbox where dispatched_at is null order by id for update skip locked limit $1', [limit]);
    for (const row of rows.rows) {
      try {
        await handler(row.topic, row.payload);
        await db.query('update outbox set dispatched_at = now(), attempts = attempts + 1 where id = $1', [row.id]);
        dispatched++;
      } catch (e) {
        await db.query('update outbox set attempts = attempts + 1, last_error = $2 where id = $1', [row.id, String((e as Error).message).slice(0, 500)]);
        failed++;
      }
    }
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
  return { dispatched, failed };
}

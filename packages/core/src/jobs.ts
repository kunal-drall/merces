import type { Queryable } from '@merces/db';

/**
 * A small Postgres job queue (SKIP LOCKED). Jobs are idempotent by construction: every job kind is safe to run
 * twice or late; `dedupeKey` collapses duplicates while a job is pending.
 */
export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function enqueueJob(db: Queryable, kind: string, payload: Record<string, unknown> = {}, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<number | null> {
  const r = await db.query<{ id: string }>(
    'insert into jobs (kind, dedupe_key, payload, run_at, max_attempts) values ($1, $2, $3, $4, $5) on conflict (kind, dedupe_key) where done_at is null and dedupe_key is not null do nothing returning id',
    [kind, opts.dedupeKey ?? null, JSON.stringify(payload), opts.runAt ?? new Date(), opts.maxAttempts ?? 10],
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

export async function claimJobs(db: Queryable, kinds: string[] | null, limit = 10, lockSeconds = 60): Promise<Job[]> {
  const r = await db.query<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number }>(
    `with next as (
       select id from jobs
       where done_at is null and run_at <= now() and (locked_until is null or locked_until < now()) and attempts < max_attempts and ($1::text[] is null or kind = any($1))
       order by run_at for update skip locked limit $2)
     update jobs j set locked_until = now() + ($3 || ' seconds')::interval, attempts = attempts + 1
     from next where j.id = next.id returning j.id, j.kind, j.payload, j.attempts`,
    [kinds, limit, String(lockSeconds)],
  );
  return r.rows.map((x) => ({ id: Number(x.id), kind: x.kind, payload: x.payload, attempts: x.attempts }));
}

export async function completeJob(db: Queryable, id: number): Promise<void> {
  await db.query('update jobs set done_at = now(), locked_until = null where id = $1', [id]);
}

export async function failJob(db: Queryable, id: number, error: string, retryInSeconds = 30): Promise<void> {
  await db.query("update jobs set locked_until = null, last_error = $2, run_at = now() + ($3 || ' seconds')::interval where id = $1", [id, error.slice(0, 500), String(retryInSeconds)]);
}

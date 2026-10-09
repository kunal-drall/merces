import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Queryable } from '@merces/db';
import { AppError } from './errors.ts';

/** A reservation older than this is treated as abandoned (its process died mid-write) and may be taken over. */
const STALE_RESERVATION_SECONDS = 300;

/**
 * Idempotency keys on every write (Part F). The first call with a key reserves it, runs the write and stores the
 * response; a repeat with the same key and body replays it; a repeat with a different body is a 409, and so is a
 * concurrent repeat while the first is still running (the write never executes twice).
 *
 * Callers pass a `scope` that includes the caller's account id, so two accounts that happen to send the same key
 * never share a row: a replay can only ever return the caller's own earlier response.
 *
 * `opts.store` redacts the response before it is persisted: a replay then returns the redacted copy. Routes
 * whose responses carry decrypted vault material (application notes, private terms) use it so the
 * idempotency table never becomes a second, unencrypted copy of that material (Part B privacy posture).
 */
export async function withIdempotency<T>(db: Queryable, scope: string, key: string | undefined, body: unknown, fn: () => Promise<{ status: number; response: T }>, opts: { store?: (response: T) => T } = {}): Promise<{ status: number; response: T; replayed: boolean }> {
  if (!key) {
    const r = await fn();
    return { ...r, replayed: false };
  }
  const requestHash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(body ?? null))));
  const fullKey = `${scope}:${key}`;
  // this request's ownership of the reservation; release and completion apply only while it still owns the row
  const owner = bytesToHex(randomBytes(16));
  const reserved = await db.query("insert into idempotency_keys (key, scope, request_hash, state, owner) values ($1, $2, $3, 'pending', $4) on conflict (key) do nothing", [fullKey, scope, requestHash, owner]);
  if (!reserved.rowCount) {
    const existing = await db.query<{ request_hash: string; status_code: number | null; response: T | null; state: string }>('select request_hash, status_code, response, state from idempotency_keys where key = $1', [fullKey]);
    const row = existing.rows[0];
    if (!row) throw AppError.conflict('idempotency key was released concurrently; retry the request');
    if (row.request_hash !== requestHash) throw AppError.conflict('idempotency key reused with a different request body');
    if (row.state === 'pending') {
      const takeover = await db.query(`update idempotency_keys set created_at = now(), owner = $2 where key = $1 and state = 'pending' and created_at < now() - interval '${STALE_RESERVATION_SECONDS} seconds'`, [fullKey, owner]);
      if (!takeover.rowCount) throw AppError.conflict('a request with this idempotency key is still in progress');
    } else {
      return { status: row.status_code ?? 200, response: row.response as T, replayed: true };
    }
  }
  let r: { status: number; response: T };
  try {
    r = await fn();
  } catch (e) {
    // the write failed: release the reservation so the client can retry with the same key
    await db.query("delete from idempotency_keys where key = $1 and state = 'pending' and owner = $2", [fullKey, owner]);
    throw e;
  }
  const stored = opts.store ? opts.store(r.response) : r.response;
  // if a takeover happened meanwhile, the new owner's result is the one stored; this caller still gets its own
  await db.query("update idempotency_keys set state = 'done', status_code = $2, response = $3 where key = $1 and state = 'pending' and owner = $4", [fullKey, r.status, JSON.stringify(stored), owner]);
  return { ...r, replayed: false };
}

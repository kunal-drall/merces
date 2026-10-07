import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Queryable } from '@merces/db';
import { AppError } from './errors.ts';

/**
 * Idempotency keys on every write (Part F). The first call with a key stores the response; a repeat with the
 * same key and body replays it; a repeat with a different body is a 409.
 */
export async function withIdempotency<T>(db: Queryable, scope: string, key: string | undefined, body: unknown, fn: () => Promise<{ status: number; response: T }>): Promise<{ status: number; response: T; replayed: boolean }> {
  if (!key) {
    const r = await fn();
    return { ...r, replayed: false };
  }
  const requestHash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(body ?? null))));
  const fullKey = `${scope}:${key}`;
  const existing = await db.query<{ request_hash: string; status_code: number; response: T }>('select request_hash, status_code, response from idempotency_keys where key = $1', [fullKey]);
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) throw AppError.conflict('idempotency key reused with a different request body');
    return { status: row.status_code, response: row.response, replayed: true };
  }
  const r = await fn();
  await db.query('insert into idempotency_keys (key, scope, request_hash, status_code, response) values ($1, $2, $3, $4, $5) on conflict (key) do nothing', [fullKey, scope, requestHash, r.status, JSON.stringify(r.response)]);
  return { ...r, replayed: false };
}

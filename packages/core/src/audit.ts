import type { Queryable } from '@merces/db';

/** Append-only audit log for every admin and attestor action (E13). The table has a trigger that forbids update/delete. */
export async function audit(db: Queryable, entry: { actor: string; actorRole: string; action: string; target?: string; detail?: Record<string, unknown> }): Promise<void> {
  await db.query('insert into audit_log (actor, actor_role, action, target, detail) values ($1, $2, $3, $4, $5)', [entry.actor, entry.actorRole, entry.action, entry.target ?? null, JSON.stringify(entry.detail ?? {})]);
}

export async function getFlag(db: Queryable, name: string): Promise<boolean> {
  const r = await db.query<{ enabled: boolean }>('select enabled from feature_flags where name = $1', [name]);
  return r.rows[0]?.enabled ?? false;
}

export async function setFlag(db: Queryable, name: string, enabled: boolean, by: string): Promise<void> {
  await db.query('insert into feature_flags (name, enabled, updated_by) values ($1, $2, $3) on conflict (name) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by', [name, enabled, by]);
}

export async function listFlags(db: Queryable): Promise<{ name: string; enabled: boolean }[]> {
  const r = await db.query<{ name: string; enabled: boolean }>('select name, enabled from feature_flags order by name');
  return r.rows;
}

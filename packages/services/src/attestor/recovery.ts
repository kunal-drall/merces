import { AppError, audit } from '@merces/core';
import { withTransaction } from '@merces/db';
import { keyUsable } from '@merces/domain';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

const TABLES = {
  tier3: { table: 'tier3_cases', id: 'case_id', owner: 'account_id', states: ['open', 'signed'] },
  annual: { table: 'tier3_annual', id: 'annual_id', owner: 'account_id', states: ['open', 'signed'] },
  extinguishment: { table: 'extinguishment_requests', id: 'request_id', owner: 'requested_by', states: ['collecting', 'ready'] },
} as const;
export type RecoverableWork = keyof typeof TABLES;

// The six TRUEUP fields form one database invariant; withdrawing or reopening clears them together.
const CLEAR_ANNUAL = `total_payment_stable = null, estimated_payment_stable = null, overpayment = null,
  underpayment = null, trueup_due_at = null, credit_period_id = null, signed_at = null,
  trueup_nonce = null, attestation_ts = null, adjustment = null, trueup_signer = null, trueup_signature = null, trueup_digest = null`;
const CLEAR_CASE = 'attestation = null, proof = null, attested_payment_stable = null, signed_at = null';

/** Requesters retain recovery access even after their attestor's registration has ended. */
export async function withdrawAttestorWork(ctx: ServiceContext, session: Session, kind: RecoverableWork, id: string): Promise<{ id: string; state: 'withdrawn' }> {
  const spec = TABLES[kind];
  return withTransaction(ctx.pool, async (db) => {
    const row = (await db.query(`select * from ${spec.table} where ${spec.id} = $1 for update`, [id])).rows[0];
    if (!row) throw AppError.notFound('attestor work');
    if (row[spec.owner] !== session.accountId && !session.roles.includes('admin')) throw AppError.forbidden('only the requester or an admin can withdraw this work');
    if (row.state === 'withdrawn') return { id, state: 'withdrawn' };
    if (!(spec.states as readonly string[]).includes(row.state)) throw AppError.conflict('this work has already been submitted');
    const chain = ctx.chains.get(row.chain);
    if (kind === 'tier3' && (await chain.getPeriod(row.series_id, row.period_id))?.reportAccepted) throw AppError.conflict('the report has already been accepted onchain');
    if (kind === 'annual' && row.state === 'signed') {
      const series = await chain.getSeries(row.series_id);
      if (!series || series.nonces.trueup !== String(row.trueup_nonce)) throw AppError.conflict('the true-up nonce moved: reconcile the onchain submission before withdrawing', { reason: 'trueup-nonce-moved' });
    }
    if (kind === 'extinguishment' && (await chain.getSeries(row.series_id))?.status === 'Extinguished') throw AppError.conflict('the series is already extinguished');
    const clear = kind === 'annual' ? CLEAR_ANNUAL : kind === 'tier3' ? CLEAR_CASE : "signatures = '[]', extinguish_nonce = null, relay_error = null";
    await db.query(`update ${spec.table} set state = 'withdrawn', decision_code = 'withdrawn', ${clear} where ${spec.id} = $1`, [id]);
    await audit(db, { actor: session.accountId, actorRole: session.roles.includes('admin') ? 'admin' : 'account', action: `${kind}.withdraw`, target: id, detail: { seriesId: row.series_id } });
    return { id, state: 'withdrawn' };
  });
}

/** A read-only inventory accompanies revocation and rotation proposals; emergency revocation is never delayed. */
export async function attestorOpenWork(ctx: ServiceContext, chain: string, address: string): Promise<Record<string, number>> {
  return (await ctx.pool.query(`select
    (select count(*)::int from hardship_requests where chain = $1 and attestor = $2 and state = 'pending') as hardship,
    (select count(*)::int from tier3_cases where chain = $1 and attestor = $2 and state in ('open','signed')) as tier3,
    (select count(*)::int from tier3_annual where chain = $1 and attestor = $2 and state in ('open','signed')) as annual,
    (select count(*)::int from extinguishment_requests where chain = $1 and $2 = any(attestors) and state in ('collecting','ready')) as extinguishments`, [chain, address])).rows[0];
}

/** Transfer work only after a same-account rotation landed. Evidence stays within the same account. */
export async function readdressAttestorWork(ctx: ServiceContext, session: Session, input: { chain: string; from: string; to: string }): Promise<Record<string, number>> {
  if (input.from === input.to) throw AppError.unprocessable('a replacement must use another key');
  const chain = ctx.chains.chains.get(input.chain);
  if (!chain) throw AppError.badRequest('unknown chain');
  return withTransaction(ctx.pool, async (db) => {
    const owners = (await db.query('select address, account_id from account_signer_keys where address = any($1::text[]) for update', [[input.from, input.to]])).rows;
    if (owners.length !== 2 || owners[0].account_id !== owners[1].account_id || (owners[0].account_id !== session.accountId && !session.roles.includes('admin'))) throw AppError.forbidden('both keys must be linked to the same account, owned by the caller or managed by an admin');
    const [from, to] = await Promise.all([chain.getSignerKey('attestor', input.from), chain.getSignerKey('attestor', input.to)]);
    if (!from || from.active || !to?.active) throw AppError.conflict('readdress work after the replacement is active and the old key is revoked', { reason: 'rotation-not-confirmed' });
    const now = await chain.now();
    const counts: Record<string, number> = { hardship: 0, tier3: 0, annual: 0, extinguishments: 0 };
    counts.hardship = (await db.query("update hardship_requests set attestor = $3 where chain = $1 and attestor = $2 and state = 'pending'", [input.chain, input.from, input.to])).rowCount ?? 0;
    const cases = (await db.query("select * from tier3_cases where chain = $1 and attestor = $2 and state in ('open','signed') for update", [input.chain, input.from])).rows;
    for (const row of cases) {
      if ((await chain.getPeriod(row.series_id, row.period_id))?.reportAccepted) continue;
      // Ended-period REPORT signatures remain useful during Stage 1's grace; keep them until they expire.
      if (row.state === 'signed' && keyUsable(from, now, { reportPeriod: row.period_id })) continue;
      await db.query(`update tier3_cases set attestor = $2, state = 'open', decision_code = 'key-rotated', ${CLEAR_CASE} where case_id = $1`, [row.case_id, input.to]);
      counts.tier3!++;
    }
    const annuals = (await db.query("select * from tier3_annual where chain = $1 and attestor = $2 and state in ('open','signed') for update", [input.chain, input.from])).rows;
    for (const row of annuals) {
      const series = await chain.getSeries(row.series_id);
      if (row.state === 'signed' && (!series || series.nonces.trueup !== String(row.trueup_nonce))) continue;
      await db.query(`update tier3_annual set attestor = $2, state = 'open', decision_code = 'key-rotated', ${CLEAR_ANNUAL} where annual_id = $1`, [row.annual_id, input.to]);
      counts.annual!++;
    }
    counts.extinguishments = (await db.query("update extinguishment_requests set attestors = array_replace(attestors, $2, $3), state = 'collecting', signatures = '[]', extinguish_nonce = null, relay_error = null, decision_code = 'key-rotated' where chain = $1 and $2 = any(attestors) and state in ('collecting','ready')", [input.chain, input.from, input.to])).rowCount ?? 0;
    await audit(db, { actor: session.accountId, actorRole: 'account', action: 'attestor.readdress-work', target: `${input.chain}:${input.from}`, detail: { to: input.to, ...counts } });
    return counts;
  });
}

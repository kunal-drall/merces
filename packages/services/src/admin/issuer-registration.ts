import type { Session } from '@merces/api';
import { AppError, audit } from '@merces/core';
import type { Queryable } from '@merces/db';
import type { UnsignedTx } from '@merces/domain';
import type { ServiceContext } from '../context.ts';

/** Persist the multisig proposal in the same transaction as application approval. Never signs as admin. */
export async function proposeIssuerRegistration(ctx: ServiceContext, db: Queryable, admin: Session, chain: string, wallet: string): Promise<{ requestId: string; tx: UnsignedTx }> {
  const eligible = (await db.query("select account_id from eligibility where chain = $1 and wallet = $2 and kind = 'issuer' and revoked_at is null", [chain, wallet])).rows[0];
  if (!eligible) throw AppError.unprocessable('approve an issuer application for this wallet first', { reason: 'issuer-not-approved' });
  const port = ctx.chains.chains.get(chain);
  if (!port) throw AppError.badRequest('unknown chain');
  const command = { kind: 'registerIssuer' as const, wallet };
  const tx = await port.build(command, (await port.info()).admin);
  const requestId = ctx.newId('adminreq');
  await db.query('insert into admin_tx_requests (request_id, kind, chain, command, created_by, meta) values ($1,$2,$3,$4,$5,$6)', [requestId, command.kind, chain, JSON.stringify(command), admin.accountId, JSON.stringify({ accountId: eligible.account_id })]);
  await audit(db, { actor: admin.accountId, actorRole: 'admin', action: 'issuer.register-proposed', target: `${chain}:${wallet}`, detail: { requestId } });
  return { requestId, tx };
}

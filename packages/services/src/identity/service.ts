import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, audit, enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import { addressFamily, normaliseAddress, type ChainFamily } from '@merces/domain';
import { signInMessage, verifyWalletSignature } from '@merces/ports';
import { issueSession, type Role, type Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E2 — identity, sign-in, onboarding and eligibility.
 * Sign-in with a wallet (Solana or EVM family); one account may link both. Applications go through review;
 * approval adds the wallet to the chain allowlist through the allowlist-manager role. Revocation never strands
 * value (C10): the chain keeps claims, redemption and window sells open for removed wallets.
 */

export const applicationCreateSchema = z.object({
  kind: z.enum(['issuer', 'backer']),
  chain: z.string(),
  wallet: z.string(),
  stablecoin: z.enum(['USDC', 'USDG']).optional(),
  persona: z.enum(['artist', 'engineer', 'freelancer', 'founder']).optional(),
  country: z.string().length(2),
  incomeSourceKinds: z.array(z.enum(['stripe', 'deel', 'distrokid', 'split', 'attestor'])).default([]),
  /** free text from the applicant; encrypted at rest, admin-only */
  notes: z.string().max(4000).optional(),
});

export class IdentityService {
  constructor(private readonly ctx: ServiceContext) {}

  // ---- sign-in
  async issueNonce(chain: string, address: string): Promise<{ nonce: string; message: string; expiresAt: string }> {
    const port = this.ctx.chains.chains.get(chain);
    if (!port) throw AppError.badRequest(`unknown chain ${chain}`);
    const family = port.family;
    const addr = normaliseAddress(address, family);
    if (addressFamily(addr) !== family) throw AppError.badRequest(`address is not a ${family} address`);
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.ctx.pool.query('insert into auth_nonces (nonce, chain, address, expires_at) values ($1,$2,$3,$4)', [nonce, chain, addr, expiresAt]);
    return { nonce, message: signInMessage({ domain: this.ctx.signInDomain, chain, address: addr, nonce, issuedAt }), expiresAt: expiresAt.toISOString() };
  }

  /** Verify the signed message; create the account on first sign-in; return a session token. */
  async verify(params: { chain: string; address: string; message: string; signature: string; linkTo?: Session | null }): Promise<{ token: string; session: Session; created: boolean }> {
    const port = this.ctx.chains.chains.get(params.chain);
    if (!port) throw AppError.badRequest(`unknown chain ${params.chain}`);
    const family: ChainFamily = port.family;
    const addr = normaliseAddress(params.address, family);
    const nonce = /Nonce: ([0-9a-f]{32})/.exec(params.message)?.[1];
    if (!nonce) throw AppError.badRequest('message has no nonce');
    const n = await this.ctx.pool.query<{ chain: string; address: string; expires_at: Date; used_at: Date | null }>('select chain, address, expires_at, used_at from auth_nonces where nonce = $1', [nonce]);
    const row = n.rows[0];
    if (!row || row.chain !== params.chain || row.address !== addr) throw AppError.unauthorized('unknown nonce');
    if (row.used_at || row.expires_at.getTime() < Date.now()) throw AppError.unauthorized('nonce expired or used');
    const ok = await verifyWalletSignature({ family, address: addr, message: params.message, signature: params.signature, allowSimulator: this.ctx.devMode });
    if (!ok) throw AppError.unauthorized('bad signature');
    await this.ctx.pool.query('update auth_nonces set used_at = now() where nonce = $1', [nonce]);

    let created = false;
    let accountId: string;
    const existing = await this.ctx.pool.query<{ account_id: string }>('select account_id from account_wallets where chain = $1 and address = $2', [params.chain, addr]);
    if (existing.rows[0]) {
      accountId = existing.rows[0].account_id;
      if (params.linkTo && params.linkTo.accountId !== accountId) throw AppError.conflict('wallet already belongs to another account');
    } else if (params.linkTo) {
      accountId = params.linkTo.accountId;
      await this.ctx.pool.query('insert into account_wallets (chain, address, account_id, family) values ($1,$2,$3,$4)', [params.chain, addr, accountId, family]);
    } else {
      accountId = this.ctx.newId('acct');
      created = true;
      await this.ctx.pool.query('insert into accounts (account_id, roles) values ($1, $2)', [accountId, ['backer']]);
      await this.ctx.pool.query('insert into account_wallets (chain, address, account_id, family) values ($1,$2,$3,$4)', [params.chain, addr, accountId, family]);
    }
    const session = await this.sessionFor(accountId);
    return { token: issueSession(this.ctx.sessionSecret, session), session, created };
  }

  async sessionFor(accountId: string): Promise<Omit<Session, 'iat'> & { iat: number }> {
    const acc = await this.ctx.pool.query<{ roles: Role[] }>('select roles from accounts where account_id = $1', [accountId]);
    if (!acc.rows[0]) throw AppError.notFound('account');
    const wallets = await this.ctx.pool.query<{ chain: string; address: string }>('select chain, address from account_wallets where account_id = $1 order by linked_at', [accountId]);
    const elig = await this.ctx.pool.query('select 1 from eligibility where account_id = $1 and revoked_at is null limit 1', [accountId]);
    return { accountId, wallets: wallets.rows, roles: acc.rows[0].roles, eligible: !!elig.rowCount, exp: Math.floor(Date.now() / 1000) + 24 * 3600, iat: Math.floor(Date.now() / 1000) };
  }

  // ---- applications
  async createApplication(session: Session, input: z.infer<typeof applicationCreateSchema>): Promise<Record<string, unknown>> {
    const port = this.ctx.chains.chains.get(input.chain);
    if (!port) throw AppError.badRequest('unknown chain');
    const wallet = normaliseAddress(input.wallet, port.family);
    if (!session.wallets.some((w) => w.chain === input.chain && w.address === wallet)) throw AppError.forbidden('the application wallet must be linked to your account');
    if (input.stablecoin) {
      const info = await port.info();
      if (!info.stablecoins[input.stablecoin]) throw AppError.badRequest(`${input.stablecoin} is not available on ${input.chain}`);
    }
    const id = this.ctx.newId('app');
    const notes = input.notes ? this.ctx.vault.encrypt(input.notes, `application:${id}`) : null;
    await this.ctx.pool.query(
      'insert into applications (application_id, account_id, kind, chain, wallet, stablecoin, persona, country, income_source_kinds, notes_encrypted) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, session.accountId, input.kind, input.chain, wallet, input.stablecoin ?? null, input.persona ?? null, input.country, input.incomeSourceKinds, notes],
    );
    return this.getApplication(id, session);
  }

  async getApplication(id: string, session: Session): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from applications where application_id = $1', [id]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('application');
    const isAdmin = session.roles.includes('admin');
    if (a.account_id !== session.accountId && !isAdmin) throw AppError.forbidden();
    return {
      applicationId: a.application_id, accountId: a.account_id, kind: a.kind, state: a.state, chain: a.chain, wallet: a.wallet, stablecoin: a.stablecoin, persona: a.persona, country: a.country,
      incomeSourceKinds: a.income_source_kinds, identityStatus: a.identity_status, decisionReasonCode: a.decision_reason_code, submittedAt: a.submitted_at, decidedAt: a.decided_at, createdAt: a.created_at,
      notes: a.notes_encrypted && (isAdmin || a.account_id === session.accountId) ? this.ctx.vault.decrypt(a.notes_encrypted, `application:${id}`) : null,
    };
  }

  async listMine(session: Session): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select application_id from applications where account_id = $1 order by created_at', [session.accountId]);
    return Promise.all(r.rows.map((x) => this.getApplication(x.application_id, session)));
  }

  async submit(id: string, session: Session): Promise<Record<string, unknown>> {
    const a = await this.getApplication(id, session);
    if (a.state !== 'draft') throw AppError.conflict(`application is ${a.state}`);
    await this.ctx.pool.query("update applications set state = 'submitted', submitted_at = now(), updated_at = now() where application_id = $1", [id]);
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'application.submitted', accountId: session.accountId, applicationId: id });
    return this.getApplication(id, session);
  }

  async startIdentityCheck(id: string, session: Session): Promise<{ checkId: string; redirectUrl: string; status: string }> {
    const a = await this.getApplication(id, session);
    if (!['draft', 'submitted', 'in_review'].includes(String(a.state))) throw AppError.conflict(`application is ${a.state}`);
    const r = await this.ctx.identity.start({ applicationId: id, accountId: session.accountId, kind: a.kind as 'issuer' | 'backer', country: (a.country as string) ?? null });
    const status = await this.ctx.identity.status(r.checkId);
    await this.ctx.pool.query('update applications set identity_check_id = $2, identity_status = $3, updated_at = now() where application_id = $1', [id, r.checkId, status]);
    return { ...r, status };
  }

  async refreshIdentity(id: string, session: Session): Promise<{ status: string }> {
    const a = await this.ctx.pool.query<{ identity_check_id: string | null; account_id: string }>('select identity_check_id, account_id from applications where application_id = $1', [id]);
    const row = a.rows[0];
    if (!row) throw AppError.notFound('application');
    if (row.account_id !== session.accountId && !session.roles.includes('admin')) throw AppError.forbidden();
    if (!row.identity_check_id) return { status: 'not_started' };
    const status = await this.ctx.identity.status(row.identity_check_id);
    await this.ctx.pool.query('update applications set identity_status = $2, updated_at = now() where application_id = $1', [id, status]);
    return { status };
  }

  /** R27: a private readiness report for the applicant — what is missing before review can approve. */
  async readiness(id: string, session: Session): Promise<Record<string, unknown>> {
    const a = await this.getApplication(id, session);
    const items: { check: string; ok: boolean; hint: string }[] = [];
    items.push({ check: 'identity', ok: a.identityStatus === 'passed', hint: 'Complete the identity check.' });
    items.push({ check: 'wallet-linked', ok: true, hint: '' });
    if (a.kind === 'issuer') {
      const kinds = a.incomeSourceKinds as string[];
      items.push({ check: 'income-source', ok: kinds.length > 0, hint: 'Connect at least one income source (Stripe, Deel, DistroKid, an onchain split, or an annual attestor).' });
      items.push({ check: 'tier-2-preferred', ok: kinds.some((k) => ['stripe', 'deel', 'distrokid', 'split'].includes(k)), hint: 'Tier 1–2 sources verify faster than an annual attestation.' });
      const floor = await this.ctx.pool.query('select 1 from threshold_data where country = $1 and year = extract(year from now())::int', [a.country]);
      items.push({ check: 'threshold-data', ok: !!floor.rowCount, hint: 'No median-income data for your country yet; the threshold floor cannot be checked.' });
      items.push({ check: 'stablecoin-on-chain', ok: !!a.stablecoin, hint: 'Pick a stablecoin available on your chain.' });
    }
    const ready = items.every((i) => i.ok);
    await this.ctx.pool.query('update applications set readiness = $2 where application_id = $1', [id, JSON.stringify({ ready, items, at: new Date().toISOString() })]);
    return { applicationId: id, ready, items };
  }

  // ---- review (admin)
  async listForReview(state: string | undefined): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select application_id, account_id, kind, state, chain, wallet, country, persona, income_source_kinds, identity_status, submitted_at from applications where ($1::text is null or state = $1) order by submitted_at nulls last, created_at', [state ?? null]);
    return r.rows.map((a) => ({ applicationId: a.application_id, accountId: a.account_id, kind: a.kind, state: a.state, chain: a.chain, wallet: a.wallet, country: a.country, persona: a.persona, incomeSourceKinds: a.income_source_kinds, identityStatus: a.identity_status, submittedAt: a.submitted_at }));
  }

  async decide(id: string, admin: Session, decision: 'approved' | 'rejected' | 'in_review', reasonCode: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from applications where application_id = $1', [id]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('application');
    if (!['submitted', 'in_review'].includes(a.state)) throw AppError.conflict(`application is ${a.state}`);
    if (decision === 'approved' && a.identity_status !== 'passed') throw AppError.unprocessable('identity check has not passed');
    // The chain call goes first: setAllowlist is idempotent onchain, so if it fails nothing has been recorded, the
    // application stays submitted/in review and the admin simply retries. Everything else commits in one transaction.
    let allowlistTx: string | null = null;
    if (decision === 'approved') allowlistTx = (await this.ctx.chains.get(a.chain).submit({ kind: 'setAllowlist', wallet: a.wallet, allowed: true }, 'allowlistManager')).txId;
    await withTransaction(this.ctx.pool, async (db) => {
      const cur = await db.query<{ state: string }>('select state from applications where application_id = $1 for update', [id]);
      if (!['submitted', 'in_review'].includes(cur.rows[0]?.state ?? '')) throw AppError.conflict(`application is ${cur.rows[0]?.state}`);
      await db.query('update applications set state = $2, reviewer = $3, decision_reason_code = $4, decided_at = case when $2 in (\'approved\',\'rejected\') then now() else null end, updated_at = now() where application_id = $1', [id, decision, admin.accountId, reasonCode]);
      await audit(db, { actor: admin.accountId, actorRole: 'admin', action: `application.${decision}`, target: id, detail: { reasonCode } });
      if (decision === 'approved') {
        await db.query('update accounts set roles = array(select distinct unnest(roles || $2::text[])) where account_id = $1', [a.account_id, [a.kind]]);
        await db.query('insert into eligibility (chain, wallet, account_id, kind, allowlist_synced_at, allowlist_tx) values ($1,$2,$3,$4, now(), $5) on conflict (chain, wallet) do update set revoked_at = null, approved_at = now(), kind = excluded.kind, account_id = excluded.account_id, allowlist_synced_at = now(), allowlist_tx = excluded.allowlist_tx', [a.chain, a.wallet, a.account_id, a.kind, allowlistTx]);
        await audit(db, { actor: admin.accountId, actorRole: 'admin', action: 'allowlist.add', target: `${a.chain}:${a.wallet}`, detail: { txId: allowlistTx } });
      }
      await enqueueOutbox(db, 'notification', { kind: `application.${decision}`, accountId: a.account_id, applicationId: id });
    });
    return this.getApplication(id, admin);
  }

  /** Uses the allowlist-manager service role on the right chain. Removal never strands value (the chain guarantees claims and sells). */
  async syncAllowlist(chain: string, wallet: string, allowed: boolean, by: string): Promise<{ txId: string }> {
    const port = this.ctx.chains.get(chain);
    const res = await port.submit({ kind: 'setAllowlist', wallet, allowed }, 'allowlistManager');
    await this.ctx.pool.query('update eligibility set allowlist_synced_at = now(), allowlist_tx = $3, revoked_at = case when $4 then null else coalesce(revoked_at, now()) end where chain = $1 and wallet = $2', [chain, wallet, res.txId, allowed]);
    await audit(this.ctx.pool, { actor: by, actorRole: 'admin', action: allowed ? 'allowlist.add' : 'allowlist.remove', target: `${chain}:${wallet}`, detail: { txId: res.txId } });
    return { txId: res.txId };
  }

  async revoke(chain: string, wallet: string, admin: Session, reasonCode: string): Promise<{ txId: string }> {
    const e = await this.ctx.pool.query('select account_id from eligibility where chain = $1 and wallet = $2', [chain, wallet]);
    if (!e.rows[0]) throw AppError.notFound('eligibility');
    const r = await this.syncAllowlist(chain, wallet, false, admin.accountId);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'eligibility.revoke', target: `${chain}:${wallet}`, detail: { reasonCode } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'eligibility.revoked', accountId: e.rows[0].account_id, chain, wallet });
    return r;
  }

  /** Grant a role directly (admin and attestor registration, E13). */
  async grantRole(accountId: string, role: Role, by: string): Promise<void> {
    await this.ctx.pool.query('update accounts set roles = array(select distinct unnest(roles || $2::text[])) where account_id = $1', [accountId, [role]]);
    await audit(this.ctx.pool, { actor: by, actorRole: 'admin', action: 'role.grant', target: accountId, detail: { role } });
  }

  /** dev:mock and tests: create accounts/eligibility for already-allowlisted simulator wallets without the sign-in dance. */
  async seedAccount(params: { accountId: string; wallets: { chain: string; address: string; family: ChainFamily }[]; roles: Role[]; eligible: boolean; kind?: 'issuer' | 'backer' }): Promise<void> {
    await this.ctx.pool.query('insert into accounts (account_id, roles) values ($1,$2) on conflict (account_id) do update set roles = excluded.roles', [params.accountId, params.roles]);
    for (const w of params.wallets) {
      await this.ctx.pool.query('insert into account_wallets (chain, address, account_id, family) values ($1,$2,$3,$4) on conflict (chain, address) do nothing', [w.chain, w.address, params.accountId, w.family]);
      if (params.eligible) await this.ctx.pool.query('insert into eligibility (chain, wallet, account_id, kind, allowlist_synced_at) values ($1,$2,$3,$4, now()) on conflict (chain, wallet) do nothing', [w.chain, w.address, params.accountId, params.kind ?? 'backer']);
    }
  }
}

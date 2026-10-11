import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@merces/core';
import type { Session } from './session.ts';
import type { AppContext } from '../context.ts';

/**
 * Access tiers (Part F). Each route declares one; the matrix in openapi.yaml (x-access) is tested endpoint by endpoint.
 *  public    — anyone
 *  backer    — any signed-in account that passed eligibility review (disclosure of terms needs this)
 *  holder    — an account holding (or having held) units of the series in the path (a bid alone does not count)
 *  issuer    — the issuer of the series in the path (or, for issuer-scoped routes without a series, any issuer role)
 *  attestor  — a key linked to the account (EIP-191 proof) that is registered and indexed as an active attestor
 *              onchain; a proposal alone is not enough
 *  admin     — admin role
 *  account   — any signed-in account (used for /me and application routes)
 */
export type AccessTier = 'public' | 'account' | 'backer' | 'holder' | 'issuer' | 'attestor' | 'admin' | 'holder-or-issuer' | 'issuer-or-attestor';

export function sessionOf(req: FastifyRequest): Session | null {
  return (req as FastifyRequest & { session?: Session | null }).session ?? null;
}

/**
 * Eligibility is read live from the `eligibility` table on every backer-tier request: a revoke takes effect on the
 * next request, not when the session token expires. The `eligible` flag in the token is informational (shown by
 * /me) and never decides access. A row counts when it is unrevoked and was approved for this account.
 */
export async function isEligible(ctx: Pick<AppContext, 'pool'>, s: Pick<Session, 'accountId'>): Promise<boolean> {
  const r = await ctx.pool.query('select 1 from eligibility where account_id = $1 and revoked_at is null limit 1', [s.accountId]);
  return !!r.rowCount;
}

/**
 * Attestor access is per key and per chain, read live on every request (A-M5-2, S4 WP7): a secp256k1 key linked to
 * the session's account (`account_signer_keys`, by the key's own EIP-191 proof) must be registered and active in
 * `attestors` (on `onChain`, when given). The token's wallets and roles never decide it: a proposal alone grants
 * nothing, an indexed revocation ends access at once, and so does unlinking the key, whatever an older token carries.
 */
export async function isRegisteredAttestor(ctx: Pick<AppContext, 'pool'>, s: Pick<Session, 'accountId'>, onChain?: string): Promise<boolean> {
  const r = await ctx.pool.query('select 1 from account_signer_keys k join attestors t on t.attestor = k.address where k.account_id = $1 and t.active and ($2::text is null or t.chain = $2) limit 1', [s.accountId, onChain ?? null]);
  return !!r.rowCount;
}

/** A key linked to the session's account has an active proposal that the indexer has not seen registered yet. */
async function attestorPending(ctx: Pick<AppContext, 'pool'>, s: Pick<Session, 'accountId'>): Promise<boolean> {
  const r = await ctx.pool.query(
    'select 1 from attestor_proposals p join account_signer_keys k on k.address = p.address where k.account_id = $1 and p.active and not exists (select 1 from attestors t where t.chain = p.chain and t.attestor = p.address) limit 1',
    [s.accountId],
  );
  return !!r.rowCount;
}

export async function requireTier(ctx: AppContext, req: FastifyRequest, _reply: FastifyReply, tier: AccessTier): Promise<Session | null> {
  if (tier === 'public') return sessionOf(req);
  const s = sessionOf(req);
  if (!s) throw AppError.unauthorized();
  const seriesId = (req.params as { seriesId?: string }).seriesId;
  const walletsOf = (chain?: string) => s.wallets.filter((w) => !chain || w.chain === chain).map((w) => w.address);
  const has = (r: Session['roles'][number]) => s.roles.includes(r);
  const isIssuerOf = async (): Promise<boolean> => {
    if (!seriesId) return has('issuer');
    const r = await ctx.pool.query<{ issuer: string; chain: string }>('select issuer, chain from series where series_id = $1', [seriesId]);
    const row = r.rows[0];
    return !!row && walletsOf(row.chain).includes(row.issuer);
  };
  const isHolderOf = async (): Promise<boolean> => {
    if (!seriesId) return false;
    // holding or having held units is what counts. A position row exists only once a wallet was minted units,
    // received them in a window or claimed, so a seller who sold everything keeps access to claim what accrued;
    // a bid alone never creates one (losing or refunded bidders see their bids and refunds through /me)
    const r = await ctx.pool.query('select 1 from positions where series_id = $1 and wallet = any($2) limit 1', [seriesId, walletsOf()]);
    return !!r.rowCount;
  };
  switch (tier) {
    case 'account':
      return s;
    case 'admin':
      if (has('admin')) return s;
      break;
    case 'attestor':
      if (has('admin') || (await isRegisteredAttestor(ctx, s))) return s;
      if (await attestorPending(ctx, s)) throw AppError.forbidden('attestor registration is pending: access starts once the multisig has registered your key onchain and it is indexed');
      break;
    case 'backer':
      if (has('admin') || ((has('backer') || has('issuer')) && (await isEligible(ctx, s)))) return s;
      break;
    case 'issuer':
      if (has('admin') || (await isIssuerOf())) return s;
      break;
    case 'holder':
      if (has('admin') || (await isHolderOf())) return s;
      break;
    case 'holder-or-issuer':
      if (has('admin') || (await isHolderOf()) || (await isIssuerOf())) return s;
      break;
    case 'issuer-or-attestor':
      // for a series, only a linked key registered on that series' chain counts (another chain's registration never stands in)
      if (has('admin') || (await isIssuerOf()) || (await isRegisteredAttestor(ctx, s, seriesId ? seriesId.slice(0, seriesId.indexOf(':')) : undefined))) return s;
      break;
  }
  throw AppError.forbidden(`requires ${tier}`);
}

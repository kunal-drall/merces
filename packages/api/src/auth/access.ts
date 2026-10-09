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
 *  attestor  — a wallet registered (and indexed) as an active attestor onchain; a proposal alone is not enough
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
 * Attestor access is the indexed onchain registry, read live on every request (A-M5-2): one of the session's wallets
 * must be registered and active in `attestors`. A proposal alone grants nothing, and an indexed deactivation ends
 * access at once, whatever role an older session token carries.
 */
export async function isRegisteredAttestor(ctx: Pick<AppContext, 'pool'>, s: Pick<Session, 'wallets'>, onChain?: string): Promise<boolean> {
  const wallets = s.wallets.filter((w) => !onChain || w.chain === onChain);
  if (!wallets.length) return false;
  const r = await ctx.pool.query('select 1 from attestors where active and (chain, attestor) in (select c, w from unnest($1::text[], $2::text[]) as t(c, w)) limit 1', [wallets.map((w) => w.chain), wallets.map((w) => w.address)]);
  return !!r.rowCount;
}

/** One of the session's wallets has an active proposal that the indexer has not seen registered yet. */
async function attestorPending(ctx: Pick<AppContext, 'pool'>, s: Pick<Session, 'wallets'>): Promise<boolean> {
  if (!s.wallets.length) return false;
  const r = await ctx.pool.query(
    'select 1 from attestor_proposals p where p.active and (p.chain, p.wallet) in (select c, w from unnest($1::text[], $2::text[]) as t(c, w)) and not exists (select 1 from attestors t where t.chain = p.chain and t.attestor = p.wallet) limit 1',
    [s.wallets.map((w) => w.chain), s.wallets.map((w) => w.address)],
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
      if (await attestorPending(ctx, s)) throw AppError.forbidden('attestor registration is pending: access starts once the multisig has registered your wallet onchain and it is indexed');
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
      // for a series, only an attestor registered on that series' chain counts (another chain's registration never stands in)
      if (has('admin') || (await isIssuerOf()) || (await isRegisteredAttestor(ctx, s, seriesId ? seriesId.slice(0, seriesId.indexOf(':')) : undefined))) return s;
      break;
  }
  throw AppError.forbidden(`requires ${tier}`);
}

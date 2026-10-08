import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@merces/core';
import type { Session } from './session.ts';
import type { AppContext } from '../context.ts';

/**
 * Access tiers (Part F). Each route declares one; the matrix in openapi.yaml (x-access) is tested endpoint by endpoint.
 *  public    — anyone
 *  backer    — any signed-in account that passed eligibility review (disclosure of terms needs this)
 *  holder    — an account holding (or having held) units of the series in the path
 *  issuer    — the issuer of the series in the path (or, for issuer-scoped routes without a series, any issuer role)
 *  attestor  — registered attestor role
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
    const r = await ctx.pool.query('select 1 from positions where series_id = $1 and wallet = any($2) and (units > 0 or claimed_total > 0 or redeemed_units > 0 or burned_units > 0) limit 1', [seriesId, walletsOf()]);
    if (r.rowCount) return true;
    const b = await ctx.pool.query('select 1 from bids where series_id = $1 and bidder = any($2) limit 1', [seriesId, walletsOf()]);
    return !!b.rowCount;
  };
  switch (tier) {
    case 'account':
      return s;
    case 'admin':
      if (has('admin')) return s;
      break;
    case 'attestor':
      if (has('attestor') || has('admin')) return s;
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
      if (has('admin') || has('attestor') || (await isIssuerOf())) return s;
      break;
  }
  throw AppError.forbidden(`requires ${tier}`);
}

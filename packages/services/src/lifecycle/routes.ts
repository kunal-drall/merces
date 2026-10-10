import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { svc } from '../context.ts';
import { LifecycleService } from './service.ts';

export function registerLifecycleRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new LifecycleService(ctx);
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/treasury/build-draw', access: 'issuer', handler: async (req, _r, session) => s.buildDraw(sid(req), session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/treasury/build-pause', access: 'issuer', handler: async (req, _r, session) => s.buildPauseReleases(sid(req), session!, z.object({ paused: z.boolean() }).parse(req.body).paused) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/payouts/build-claim', access: 'holder', handler: async (req, _r, session) => s.buildClaim(sid(req), session!, z.object({ holder: z.string() }).parse(req.body).holder) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/redemption/quote', access: 'holder-or-issuer', handler: async (req) => s.quote(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/redemption/build-redeem', access: 'issuer', handler: async (req, _r, session) => s.buildRedeem(sid(req), session!, z.object({ maxPricePerUnit: z.string().regex(/^\d+$/) }).parse(req.body).maxPricePerUnit) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/redemption/build-claim', access: 'holder', handler: async (req, _r, session) => s.buildClaimRedemption(sid(req), session!, z.object({ holder: z.string() }).parse(req.body).holder) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/redemption', access: 'holder-or-issuer', handler: async (req) => s.redemption(sid(req)) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/retirement', access: 'public', handler: async (req) => s.retirement(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/retirement/crank-burn', access: 'admin', handler: async (req, _r, session) => s.burnRetiredHolders(sid(req), session!.accountId) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/window', access: 'public', handler: async (req) => s.window(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/window/build-commit', access: 'account', handler: async (req, _r, session) => s.buildWindowCommit(sid(req), session!, z.object({ wallet: z.string(), side: z.enum(['buy', 'sell']), commitment: z.string(), deposit: z.string().regex(/^\d+$/), units: z.string().regex(/^\d+$/) }).parse(req.body)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/window/build-reveal', access: 'account', handler: async (req, _r, session) => s.buildWindowReveal(sid(req), session!, z.object({ wallet: z.string(), side: z.enum(['buy', 'sell']), pricePerUnit: z.string().regex(/^\d+$/), quantity: z.string().regex(/^\d+$/), salt: z.string() }).parse(req.body)) });
  defineRoute(app, ctx, { method: 'PUT', url: '/series/:seriesId/window/backup', access: 'account', handler: async (req, _r, session) => {
    const b = z.object({ wallet: z.string(), ciphertext: z.string().min(1), keyHint: z.string().max(200).nullable().default(null) }).parse(req.body);
    return s.putWindowBackup(sid(req), session!, b.wallet, b.ciphertext, b.keyHint);
  } });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/window/backup/:wallet', access: 'account', handler: async (req, _r, session) => s.getWindowBackup(sid(req), session!, (req.params as { wallet: string }).wallet) });
}

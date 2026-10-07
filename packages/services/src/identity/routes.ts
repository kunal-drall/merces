import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { IdentityService, applicationCreateSchema } from './service.ts';

export function registerIdentityRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new IdentityService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;

  defineRoute(app, ctx, { method: 'POST', url: '/auth/nonce', access: 'public', handler: async (req) => s.issueNonce(...(((b) => [b.chain, b.address]) as (b: { chain: string; address: string }) => [string, string])(z.object({ chain: z.string(), address: z.string() }).parse(req.body))) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/auth/verify', access: 'public',
    handler: async (req) => {
      const b = z.object({ chain: z.string(), address: z.string(), message: z.string(), signature: z.string() }).parse(req.body);
      const r = await s.verify({ ...b, linkTo: null });
      return { token: r.token, account: { accountId: r.session.accountId, wallets: r.session.wallets, roles: r.session.roles, eligible: r.session.eligible }, created: r.created };
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/me/wallets/link', access: 'account',
    handler: async (req, _reply, session) => {
      const b = z.object({ chain: z.string(), address: z.string(), message: z.string(), signature: z.string() }).parse(req.body);
      const r = await s.verify({ ...b, linkTo: session });
      return { token: r.token, account: { accountId: r.session.accountId, wallets: r.session.wallets, roles: r.session.roles, eligible: r.session.eligible } };
    },
  });
  defineRoute(app, ctx, { method: 'POST', url: '/me/session/refresh', access: 'account', handler: async (_req, _reply, session) => {
    const fresh = await s.sessionFor(session!.accountId);
    const { issueSession } = await import('@merces/api');
    return { token: issueSession(ctx.sessionSecret, fresh), account: { accountId: fresh.accountId, wallets: fresh.wallets, roles: fresh.roles, eligible: fresh.eligible } };
  } });

  defineRoute(app, ctx, {
    method: 'POST', url: '/applications', access: 'account',
    handler: async (req, reply, session) => {
      const body = applicationCreateSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, 'applications', idem(req), body, async () => ({ status: 201, response: await s.createApplication(session!, body) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/applications/mine', access: 'account', handler: async (_req, _reply, session) => ({ applications: await s.listMine(session!) }) });
  defineRoute(app, ctx, { method: 'GET', url: '/applications/:applicationId', access: 'account', handler: async (req, _reply, session) => s.getApplication((req.params as { applicationId: string }).applicationId, session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/applications/:applicationId/submit', access: 'account', handler: async (req, _reply, session) => s.submit((req.params as { applicationId: string }).applicationId, session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/applications/:applicationId/identity/start', access: 'account', handler: async (req, _reply, session) => s.startIdentityCheck((req.params as { applicationId: string }).applicationId, session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/applications/:applicationId/identity/refresh', access: 'account', handler: async (req, _reply, session) => s.refreshIdentity((req.params as { applicationId: string }).applicationId, session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/applications/:applicationId/readiness', access: 'account', handler: async (req, _reply, session) => s.readiness((req.params as { applicationId: string }).applicationId, session!) });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/applications', access: 'admin', handler: async (req) => ({ applications: await s.listForReview(z.object({ state: z.string().optional() }).parse(req.query).state) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/applications/:applicationId/decide', access: 'admin',
    handler: async (req, _reply, session) => {
      const b = z.object({ decision: z.enum(['approved', 'rejected', 'in_review']), reasonCode: z.string().min(1).max(64) }).parse(req.body);
      const r = await withIdempotency(ctx.pool, 'decide', idem(req), { id: (req.params as { applicationId: string }).applicationId, ...b }, async () => ({ status: 200, response: await s.decide((req.params as { applicationId: string }).applicationId, session!, b.decision, b.reasonCode) }));
      return r.response;
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/eligibility/:chain/:wallet/revoke', access: 'admin',
    handler: async (req, _reply, session) => {
      const p = req.params as { chain: string; wallet: string };
      const b = z.object({ reasonCode: z.string().min(1).max(64) }).parse(req.body);
      return s.revoke(p.chain, p.wallet, session!, b.reasonCode);
    },
  });
}

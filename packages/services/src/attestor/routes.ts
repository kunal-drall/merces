import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import {
  AttestorService, extinguishSchema, fxSignSchema, hardshipDecideSchema, hardshipRequestSchema, tier3AnnualOpenSchema, tier3AnnualSignSchema, tier3OpenSchema, tier3SignSchema,
} from './service.ts';

const periodParam = z.string().regex(/^\d{4}Q[1-4]$/);

export function registerAttestorRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new AttestorService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  const param = (req: { params: unknown }, name: string) => (req.params as Record<string, string>)[name]!;

  // ---- profile and queue
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/me', access: 'attestor', handler: async (_req, _r, session) => s.me(session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/queue', access: 'attestor', handler: async (_req, _r, session) => s.queue(session!) });

  // ---- hardship pause (private review)
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/hardship', access: 'issuer',
    handler: async (req, reply, session) => {
      const b = hardshipRequestSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, 'hardship', idem(req), { seriesId: sid(req), ...b }, async () => ({ status: 201, response: await s.requestHardship(sid(req), session!, b) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/hardship', access: 'holder-or-issuer', handler: async (req) => s.hardshipStatus(sid(req)) });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/hardship/:hardshipId', access: 'attestor', handler: async (req, _r, session) => s.getHardship(param(req, 'hardshipId'), session!) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/hardship/:hardshipId/decide', access: 'attestor',
    handler: async (req, _r, session) => {
      const b = hardshipDecideSchema.parse(req.body);
      const id = param(req, 'hardshipId');
      return (await withIdempotency(ctx.pool, 'hardship-decide', idem(req), { id, ...b }, async () => ({ status: 200, response: await s.decideHardship(id, session!, b) }))).response;
    },
  });

  // ---- tier 3: quarterly cases and the annual true-up
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/tier3/annual', access: 'issuer',
    handler: async (req, reply, session) => {
      const b = tier3AnnualOpenSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, 'tier3-annual', idem(req), { seriesId: sid(req), ...b }, async () => ({ status: 201, response: await s.openAnnual(sid(req), session!, b) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/tier3/:periodId', access: 'issuer',
    handler: async (req, reply, session) => {
      const periodId = periodParam.parse(param(req, 'periodId'));
      const b = tier3OpenSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, 'tier3-open', idem(req), { seriesId: sid(req), periodId, ...b }, async () => ({ status: 201, response: await s.openTier3Case(sid(req), periodId, session!, b) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/tier3', access: 'issuer', handler: async (req) => s.listTier3ForSeries(sid(req)) });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/tier3/annual/:annualId', access: 'attestor', handler: async (req, _r, session) => s.getAnnual(param(req, 'annualId'), session!) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/tier3/annual/:annualId/sign', access: 'attestor',
    handler: async (req, _r, session) => {
      const b = tier3AnnualSignSchema.parse(req.body);
      const id = param(req, 'annualId');
      return (await withIdempotency(ctx.pool, 'tier3-annual-sign', idem(req), { id, ...b }, async () => ({ status: 200, response: await s.signAnnual(id, session!, b) }))).response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/tier3/:caseId', access: 'attestor', handler: async (req, _r, session) => s.getTier3Case(param(req, 'caseId'), session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/tier3/:caseId/prefill-spec', access: 'attestor', handler: async (req, _r, session) => s.prefillSpec(param(req, 'caseId'), session!) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/tier3/:caseId/sign', access: 'attestor',
    handler: async (req, _r, session) => {
      const b = tier3SignSchema.parse(req.body);
      const id = param(req, 'caseId');
      return (await withIdempotency(ctx.pool, 'tier3-sign', idem(req), { id, ...b }, async () => ({ status: 200, response: await s.signTier3Case(id, session!, b) }))).response;
    },
  });

  // ---- FX fallback
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/fx-requests', access: 'attestor', handler: async (_req, _r, session) => ({ requests: await s.listFxRequests(session!) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/fx-requests/:requestId/sign', access: 'attestor',
    handler: async (req, _r, session) => {
      const b = fxSignSchema.parse(req.body);
      const id = param(req, 'requestId');
      return (await withIdempotency(ctx.pool, 'fx-sign', idem(req), { id, ...b }, async () => ({ status: 200, response: await s.signFxRequest(id, session!, b) }))).response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/reporting/fx-fallback/:periodId', access: 'issuer', handler: async (req) => s.fxFallbackForSeries(sid(req), periodParam.parse(param(req, 'periodId'))) });

  // ---- extinguishment (two attestors)
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/extinguish', access: 'attestor',
    handler: async (req, reply, session) => {
      const b = extinguishSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, 'extinguish', idem(req), b, async () => ({ status: 201, response: await s.requestExtinguishment(session!, b) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/attestor/extinguish/:requestId', access: 'attestor', handler: async (req, _r, session) => s.getExtinguishment(param(req, 'requestId'), session!) });
}

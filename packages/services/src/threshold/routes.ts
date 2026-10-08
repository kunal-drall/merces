import type { FastifyInstance } from 'fastify';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { ThresholdService, thresholdKeySchema, thresholdRowSchema, yearSchema } from './service.ts';

/** E9 threshold data service: public summary, admin editing with history, yearly indexing candidates and nudges. */
export function registerThresholdRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new ThresholdService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const key = (req: { params: unknown }) => thresholdKeySchema.parse(req.params);
  const year = (req: { params: unknown }) => yearSchema.parse((req.params as { year: string }).year);

  defineRoute(app, ctx, { method: 'GET', url: '/thresholds', access: 'public', handler: async () => s.listPublic() });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/thresholds', access: 'admin', handler: async () => s.listAdmin() });
  defineRoute(app, ctx, {
    method: 'GET', url: '/admin/thresholds/:country/:year/history', access: 'admin',
    handler: async (req) => {
      const k = key(req);
      return s.history(k.country, k.year);
    },
  });
  defineRoute(app, ctx, {
    method: 'PUT', url: '/admin/thresholds/:country/:year', access: 'admin',
    handler: async (req, reply, session) => {
      const k = key(req);
      const body = thresholdRowSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `thresholds:${session!.accountId}`, idem(req), { ...k, ...body }, async () => {
        const out = await s.upsert(k.country, k.year, body, session!);
        return { status: out.created ? 201 : 200, response: out };
      });
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, {
    method: 'DELETE', url: '/admin/thresholds/:country/:year', access: 'admin',
    handler: async (req, _reply, session) => {
      const k = key(req);
      const r = await withIdempotency(ctx.pool, `thresholds-delete:${session!.accountId}`, idem(req), k, async () => ({ status: 200, response: await s.remove(k.country, k.year, session!) }));
      return r.response;
    },
  });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/indexing/:year/candidates', access: 'admin', handler: async (req) => s.indexingCandidates(year(req)) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/indexing/:year/notify', access: 'admin',
    handler: async (req, _reply, session) => {
      const y = year(req);
      const r = await withIdempotency(ctx.pool, `indexing-notify:${session!.accountId}`, idem(req), { year: y }, async () => ({ status: 200, response: await s.notifyIndexing(y, session!) }));
      return r.response;
    },
  });
}

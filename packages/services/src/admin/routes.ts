import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { AdminService, auditLogQuerySchema, auditSamplesQuerySchema, auditSamplesSchema, keeperRunsQuerySchema, pauseRaisesSchema, registerAttestorSchema, registerVerifierKeySchema, txRequestsQuerySchema } from './service.ts';

/** E13 admin API. Every route is admin-tier; every write is audited and takes an Idempotency-Key. */
export function registerAdminRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new AdminService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const chainQuery = z.object({ chain: z.string().optional() });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/overview', access: 'admin', handler: async () => s.overview() });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/flags', access: 'admin', handler: async () => ({ flags: await s.flags() }) });
  defineRoute(app, ctx, {
    method: 'PUT', url: '/admin/flags/:name', access: 'admin',
    handler: async (req, _reply, session) => {
      const b = z.object({ enabled: z.boolean() }).parse(req.body);
      return s.setFlag((req.params as { name: string }).name, b.enabled, session!);
    },
  });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/audit-log', access: 'admin', handler: async (req) => ({ entries: await s.auditLog(auditLogQuerySchema.parse(req.query)) }) });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/attestors', access: 'admin', handler: async () => ({ attestors: await s.listAttestors() }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/attestors', access: 'admin',
    handler: async (req, reply, session) => {
      const b = registerAttestorSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `admin-attestors:${session!.accountId}`, idem(req), b, async () => ({ status: 201, response: await s.registerAttestor(b, session!) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/tx-requests', access: 'admin', handler: async (req) => ({ requests: await s.listRequests(txRequestsQuerySchema.parse(req.query)) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/tx-requests/:requestId/sent', access: 'admin',
    handler: async (req, _reply, session) => {
      const id = (req.params as { requestId: string }).requestId;
      const b = z.object({ txId: z.string().min(1).max(256) }).parse(req.body);
      const r = await withIdempotency(ctx.pool, `admin-tx-sent:${session!.accountId}`, idem(req), { id, ...b }, async () => ({ status: 200, response: await s.markSent(id, b.txId, session!) }));
      return r.response;
    },
  });

  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/verifier-keys', access: 'admin',
    handler: async (req, reply, session) => {
      const b = registerVerifierKeySchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `admin-verifier-keys:${session!.accountId}`, idem(req), b, async () => ({ status: 201, response: await s.registerVerifierKey(b, session!) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/verifier-keys', access: 'admin', handler: async (req) => ({ chains: await s.verifierKeys(chainQuery.parse(req.query).chain) }) });

  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/raises/pause', access: 'admin',
    handler: async (req, reply, session) => {
      const b = pauseRaisesSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `admin-raises-pause:${session!.accountId}`, idem(req), b, async () => ({ status: 201, response: await s.pauseNewRaises(b, session!) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/eligibility', access: 'admin', handler: async (req) => ({ rows: await s.eligibility(chainQuery.parse(req.query).chain) }) });

  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/audit-samples', access: 'admin',
    handler: async (req, _reply, session) => {
      const b = auditSamplesSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `admin-audit-samples:${session!.accountId}`, idem(req), b, async () => ({ status: 200, response: await s.drawAuditSamples(b.count, session!) }));
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/audit-samples', access: 'admin', handler: async (req) => ({ samples: await s.listAuditSamples(auditSamplesQuerySchema.parse(req.query)) }) });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/keepers/runs', access: 'admin', handler: async (req) => ({ runs: await s.keeperRuns(keeperRunsQuerySchema.parse(req.query)) }) });
}

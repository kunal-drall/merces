import type { FastifyInstance } from 'fastify';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { AccountingService, exportQuerySchema, feesQuerySchema, runsQuerySchema } from './service.ts';

/** E11 fees and accounting (R33): fee ledger, per-series statements, reconciliation runs and the money-event CSV export. */
export function registerAccountingRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new AccountingService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;

  defineRoute(app, ctx, { method: 'GET', url: '/admin/accounting/fees', access: 'admin', handler: async (req) => s.fees(feesQuerySchema.parse(req.query)) });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/accounting/series/:seriesId', access: 'admin', handler: async (req) => s.statement(sid(req)) });
  // the issuer's own statement: the same numbers, resolved against the series in the path
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/accounting', access: 'issuer', handler: async (req) => s.statement(sid(req)) });

  defineRoute(app, ctx, {
    method: 'GET', url: '/admin/accounting/reconcile', access: 'admin',
    handler: async (req, _reply, session) => {
      // every call persists and audits a run; an Idempotency-Key lets a retried call replay the same run instead of adding one
      const r = await withIdempotency(ctx.pool, `accounting-reconcile:${session!.accountId}`, idem(req), {}, async () => ({ status: 200, response: await s.reconcile(session!) }));
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/accounting/reconcile/runs', access: 'admin', handler: async (req) => ({ runs: await s.listRuns(runsQuerySchema.parse(req.query).limit) }) });

  defineRoute(app, ctx, {
    method: 'GET', url: '/admin/accounting/export', access: 'admin',
    handler: async (req, reply, session) => {
      const out = await s.exportCsv(exportQuerySchema.parse(req.query), session!);
      reply.type('text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${out.filename}"`);
      reply.header('x-row-count', String(out.rows));
      return out.csv;
    },
  });
}

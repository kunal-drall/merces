import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { SOURCE_DEFINITIONS, proverArtifactFile, stage1ProverArtifacts } from '@merces/ports';
import { svc } from '../context.ts';
import { ProofOfIncomeService, assembleSchema } from './service.ts';

export function registerPoiRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new ProofOfIncomeService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  const rid = (req: { params: unknown }) => (req.params as { reportId: string }).reportId;

  // Stage 1's ProofOfIncome circuit: the layout, the verification key and the artifacts devices prove with, each with
  // its sha256 (checked against the Stage 1 build manifest before anything is served)
  defineRoute(app, ctx, { method: 'GET', url: '/prover/artifacts', access: 'public', handler: async () => ({ ...(await stage1ProverArtifacts('/prover')), acceptedSystems: ctx.proofVerifier.systems }) });
  for (const kind of ['wasm', 'zkey'] as const) {
    defineRoute(app, ctx, {
      method: 'GET', url: `/prover/report.${kind}`, access: 'public',
      handler: async (_req, reply) => {
        const f = await proverArtifactFile(kind);
        reply.header('content-type', f.contentType).header('x-content-sha256', f.sha256).header('cache-control', 'public, max-age=86400');
        return f.bytes;
      },
    });
  }
  defineRoute(app, ctx, { method: 'GET', url: '/income-sources', access: 'public', handler: async () => ({ sources: Object.values(SOURCE_DEFINITIONS).map((d) => ({ kind: d.kind, name: d.name, provider: ctx.zktls.provider, reclaimProviderId: d.reclaimProviderId, figureUnit: d.figureUnit, defaultCurrency: d.defaultCurrency, notes: d.notes })) }) });
  defineRoute(app, ctx, { method: 'GET', url: '/reporting/verifier', access: 'public', handler: async () => s.verifierInfo() });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/reporting/schedule', access: 'issuer', handler: async (req, _r, session) => s.schedule(sid(req), session!) });
  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/reporting/prior', access: 'public',
    handler: async (req) => s.reportingPrior(sid(req), z.object({ periodId: z.string().regex(/^\d{4}Q[1-4]$/).optional() }).parse(req.query ?? {}).periodId),
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/reporting/fx/:periodId', access: 'issuer', handler: async (req) => s.resolveFx(sid(req), (req.params as { periodId: string }).periodId) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/reporting/zktls-session', access: 'issuer',
    handler: async (req, _r, session) => {
      const b = z.object({ periodId: z.string().regex(/^\d{4}Q[1-4]$/), source: z.enum(['stripe', 'deel', 'distrokid']) }).parse(req.body);
      return s.createZkTlsSession(sid(req), session!, b.periodId, b.source);
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/reports', access: 'issuer',
    handler: async (req, reply, session) => {
      const b = assembleSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `reports:${session!.accountId}`, idem(req), { ...b, seriesId: sid(req) }, async () => ({ status: 201, response: await s.assemble(sid(req), session!, b) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/reports', access: 'holder-or-issuer', handler: async (req, _r, session) => ({ reports: await s.listReports(sid(req), session!) }) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/reporting/splits/:periodId', access: 'issuer', handler: async (req, _r, session) => s.splits(sid(req), session!, (req.params as { periodId: string }).periodId) });
  defineRoute(app, ctx, { method: 'GET', url: '/reports/:reportId', access: 'account', handler: async (req, _r, session) => {
    const rep = await s.getReport(rid(req));
    await (s as unknown as { seriesForIssuer(id: string, s: unknown): Promise<unknown> }).seriesForIssuer(String(rep.seriesId), session); // issuer (or admin) only
    return rep;
  } });
  defineRoute(app, ctx, { method: 'POST', url: '/reports/:reportId/build-submit', access: 'account', handler: async (req, _r, session) => s.buildSubmit(rid(req), session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/reports/:reportId/submitted', access: 'account', handler: async (req, _r, session) => s.markSubmitted(rid(req), session!, z.object({ txId: z.string() }).parse(req.body).txId) });
  defineRoute(app, ctx, { method: 'POST', url: '/reports/:reportId/build-payin', access: 'account', handler: async (req, _r, session) => s.buildPayIn(rid(req), session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/reports/:reportId/paid', access: 'account', handler: async (req, _r, session) => s.markPaid(rid(req), session!, z.object({ txId: z.string() }).parse(req.body).txId) });
}

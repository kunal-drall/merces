import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { AppError, withIdempotency } from '@merces/core';
import { termsCommitment, type SignedTx } from '@merces/domain';
import { svc } from '../context.ts';
import { TermsService, privateTermsSchema, publicTermsSchema } from './service.ts';

export function registerTermsRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new TermsService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;

  defineRoute(app, ctx, {
    method: 'POST', url: '/terms/validate', access: 'account',
    handler: async (req) => {
      const b = z.object({ chain: z.string(), public: publicTermsSchema, private: privateTermsSchema.nullable().default(null) }).parse(req.body);
      return s.validate(b.chain, b.public, b.private, new Date(ctx.wallClock() * 1000).getUTCFullYear());
    },
  });
  /** Anyone can recompute a commitment from disclosed inputs to check they were shown the true terms. */
  defineRoute(app, ctx, {
    method: 'POST', url: '/terms/commitment', access: 'public',
    handler: async (req) => {
      const b = z.object({ threshold: z.string().regex(/^\d+$/), ratePerUnitWad: z.string().regex(/^\d+$/), reportingCurrency: z.string(), indexingRule: z.string(), salt: z.string() }).parse(req.body);
      return { commitment: termsCommitment(b) };
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/thresholds/:country', access: 'public', handler: async (req) => {
    const { country } = req.params as { country: string };
    const r = await ctx.pool.query('select country, year, currency, median_full_time_income, inflation_index_bps, source, source_url, retrieved_at, placeholder from threshold_data where country = $1 order by year desc', [country.toUpperCase()]);
    if (!r.rows.length) throw AppError.notFound('threshold data');
    return { rows: r.rows.map((x) => ({ country: x.country, year: x.year, currency: x.currency, medianFullTimeIncome: x.median_full_time_income, inflationIndexBps: x.inflation_index_bps, source: x.source, sourceUrl: x.source_url, retrievedAt: x.retrieved_at, placeholder: x.placeholder })) };
  } });

  defineRoute(app, ctx, {
    method: 'POST', url: '/drafts', access: 'issuer',
    handler: async (req, reply, session) => {
      const b = z.object({ chain: z.string(), issuer: z.string() }).parse(req.body);
      const r = await withIdempotency(ctx.pool, `drafts:${session!.accountId}`, idem(req), b, async () => ({ status: 201, response: await s.createDraft(session!, b.chain, b.issuer) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/drafts/mine', access: 'issuer', handler: async (_req, _reply, session) => ({ drafts: await s.listDrafts(session!) }) });
  defineRoute(app, ctx, { method: 'GET', url: '/drafts/:draftId', access: 'issuer', handler: async (req, _reply, session) => s.getDraft((req.params as { draftId: string }).draftId, session!) });
  defineRoute(app, ctx, {
    method: 'PUT', url: '/drafts/:draftId/terms', access: 'issuer',
    handler: async (req, _reply, session) => {
      const b = z.object({ public: publicTermsSchema, private: privateTermsSchema }).parse(req.body);
      return s.setTerms((req.params as { draftId: string }).draftId, session!, b.public, b.private);
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/drafts/:draftId/terms/private', access: 'issuer', handler: async (req, _reply, session) => s.disclose({ draftId: (req.params as { draftId: string }).draftId }, session!, 'issuer-draft-review') });
  defineRoute(app, ctx, { method: 'POST', url: '/drafts/:draftId/build-create-series', access: 'issuer', handler: async (req, _reply, session) => s.buildCreateSeries((req.params as { draftId: string }).draftId, session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/drafts/:draftId/link-created', access: 'issuer', handler: async (req, _reply, session) => s.linkCreated((req.params as { draftId: string }).draftId, session!) });

  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/terms', access: 'backer', handler: async (req, _reply, session) => s.disclose({ seriesId: (req.params as { seriesId: string }).seriesId }, session!, 'backer-disclosure') });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/terms/access-log', access: 'issuer', handler: async (req) => ({ accesses: await s.accessLog((req.params as { seriesId: string }).seriesId) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/amendments/inflation', access: 'issuer',
    handler: async (req, _reply, session) => {
      const b = z.object({ year: z.number().int().min(2026).max(2100) }).parse(req.body);
      return s.prepareInflationAmendment((req.params as { seriesId: string }).seriesId, session!, b.year);
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/amendments', access: 'issuer-or-attestor', handler: async (req) => ({ amendments: await s.listAmendments((req.params as { seriesId: string }).seriesId) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/amendments/:amendmentId/attest', access: 'attestor',
    handler: async (req, _reply, session) => {
      const b = z.object({ attestorWallet: z.string(), approve: z.boolean() }).parse(req.body);
      if (!session!.wallets.some((w) => w.address === b.attestorWallet)) throw AppError.forbidden('attestor wallet must be linked to your account');
      return s.attestAmendment((req.params as { amendmentId: string }).amendmentId, session!, b.attestorWallet, b.approve);
    },
  });
  defineRoute(app, ctx, { method: 'POST', url: '/amendments/:amendmentId/build', access: 'issuer', handler: async (req, _reply, session) => s.buildAmendTerms((req.params as { amendmentId: string }).amendmentId, session!) });
  defineRoute(app, ctx, { method: 'POST', url: '/amendments/:amendmentId/apply', access: 'issuer', handler: async (req) => {
    await s.applyAmendment((req.params as { amendmentId: string }).amendmentId);
    return { ok: true };
  } });

  /** Relay a user-signed transaction to its chain (the backend never signs for users). */
  defineRoute(app, ctx, {
    method: 'POST', url: '/tx/send', access: 'account',
    handler: async (req, _reply, session) => {
      const signed = req.body as SignedTx;
      if (!signed?.tx?.chain || !signed.signatures) throw AppError.badRequest('signed transaction required');
      if (!session!.wallets.some((w) => w.address === signed.tx.signer) && !session!.roles.includes('admin')) throw AppError.forbidden('signer is not one of your wallets');
      const res = await ctx.chains.get(signed.tx.chain).send(signed);
      return { txId: res.txId, blockTime: res.blockTime, events: res.events.map((e) => ({ type: e.type, seq: e.seq, payload: e.payload })) };
    },
  });
}

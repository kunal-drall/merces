import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { AppError, withIdempotency } from '@merces/core';
import type { SignedTx } from '@merces/domain';
import { svc } from '../context.ts';
import { thresholdPublicView } from '../threshold/service.ts';
import { TERMS_SCHEME, TermsService, commitTerms, privateTermsSchema, publicTermsSchema } from './service.ts';

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
      // Stage 1's Poseidon(5) commitment over the vault payload's fields (the whole disclosed payload may be posted; its
      // other fields are ignored); `termsSalt` is the field element the payload carries (decimal)
      const b = z.object({ threshold: z.string().regex(/^\d+$/), ratePerUnitWad: z.string().regex(/^\d+$/), reportingCurrency: z.string(), indexingRule: z.string(), termsSalt: z.string().regex(/^\d{1,78}$/) }).parse(req.body);
      return { commitment: commitTerms(b), scheme: TERMS_SCHEME };
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/thresholds/:country', access: 'public', handler: async (req) => {
    const { country } = req.params as { country: string };
    const r = await ctx.pool.query('select country, year, currency, median_full_time_income, inflation_index_bps, source, source_url, retrieved_at, placeholder from threshold_data where country = $1 order by year desc', [country.toUpperCase()]);
    if (!r.rows.length) throw AppError.notFound('threshold data');
    // same view as the threshold service, so retrievedAt is a YYYY-MM-DD date on every endpoint
    return { rows: r.rows.map(thresholdPublicView) };
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
    handler: async (req, reply, session) => {
      const seriesId = (req.params as { seriesId: string }).seriesId;
      const b = z.object({ year: z.number().int().min(2026).max(2100) }).parse(req.body);
      // seriesId is part of the hashed body so reusing a key on another series is a 409, not a replay
      const r = await withIdempotency(ctx.pool, `amend-inflation:${session!.accountId}`, idem(req), { seriesId, ...b }, async () => ({ status: 200, response: await s.prepareInflationAmendment(seriesId, session!, b.year) }));
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/amendments', access: 'issuer-or-attestor', handler: async (req) => ({ amendments: await s.listAmendments((req.params as { seriesId: string }).seriesId) }) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/attestor/amendments/:amendmentId/attest', access: 'attestor',
    handler: async (req, _reply, session) => {
      // the attestor key the attestor acts with (S4 WP7): a secp256k1 key's 20-byte address, any case
      const b = z.object({ attestor: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((x) => x.toLowerCase()), approve: z.boolean() }).strict().parse(req.body);
      return s.attestAmendment((req.params as { amendmentId: string }).amendmentId, session!, b.attestor, b.approve);
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
      // the signer is one of the account's wallets, or (transitional until S4 WP13, while approvePause and extinguish are
      // still sent by an attestor key's address) an attestor key linked to the account, read live
      const own = session!.wallets.some((w) => w.address === signed.tx.signer)
        || (typeof signed.tx.signer === 'string' && !!(await ctx.pool.query('select 1 from account_signer_keys where address = $1 and account_id = $2', [signed.tx.signer, session!.accountId])).rowCount);
      if (!own && !session!.roles.includes('admin')) throw AppError.forbidden('signer is not one of your wallets or linked keys');
      if (!ctx.chains.chains.has(signed.tx.chain)) throw AppError.badRequest(`unknown chain ${signed.tx.chain}`);
      const res = await ctx.chains.get(signed.tx.chain).send(signed);
      return { txId: res.txId, blockTime: res.blockTime, events: res.events.map((e) => ({ type: e.type, seq: e.seq, payload: e.payload })) };
    },
  });
}

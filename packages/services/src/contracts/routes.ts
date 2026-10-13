import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { MockESign } from '@merces/ports';
import { AppError } from '@merces/core';
import { svc } from '../context.ts';
import { ContractService } from './service.ts';

export function registerContractRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new ContractService(ctx);
  defineRoute(app, ctx, { method: 'POST', url: '/drafts/:draftId/contract/test-sign', access: 'issuer', handler: async (req, _reply, session) => {
    z.object({ testOnly: z.literal(true) }).strict().parse(req.body);
    return s.testSign((req.params as { draftId: string }).draftId, session!);
  } });
  defineRoute(app, ctx, { method: 'POST', url: '/drafts/:draftId/contract/prepare', access: 'issuer', handler: async (req, _reply, session) => s.prepare((req.params as { draftId: string }).draftId, session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/drafts/:draftId/contract', access: 'issuer', handler: async (req, _reply, session) => s.status((req.params as { draftId: string }).draftId, session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/drafts/:draftId/contract/document', access: 'issuer', handler: async (req, _reply, session) => s.signedDocument((req.params as { draftId: string }).draftId, session!) });
  /** Provider webhook: the provider calls back with its envelope reference; we re-poll the provider rather than trust the body. */
  defineRoute(app, ctx, {
    method: 'POST', url: '/contracts/webhook/:provider', access: 'public',
    handler: async (req) => {
      // Real providers use authenticated owner polling. Unsigned callbacks cannot trigger vendor work or reveal status.
      if(!(ctx.esign instanceof MockESign))throw AppError.forbidden('use authenticated contract status polling');
      const b = z.object({ sessionId: z.string() }).parse(req.body);
      return s.refresh(b.sessionId);
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/admin/contracts/templates', access: 'admin',
    handler: async (req, _reply, session) => {
      const b = z.object({ kind: z.enum(['heu', 'charter']), version: z.string().min(1), body: z.string().min(1) }).parse(req.body);
      return s.addTemplate(b.kind, b.version, b.body, session!.accountId);
    },
  });
  if (ctx.devMode) {
    /** Mock-mode only: simulate the issuer completing the envelope. */
    defineRoute(app, ctx, {
      method: 'POST', url: '/dev/esign/complete', access: 'public', devOnly: true,
      handler: async (req) => {
        const b = z.object({ sessionId: z.string(), outcome: z.enum(['signed', 'declined']).default('signed') }).parse(req.body);
        const r = await ctx.pool.query<{ provider_ref: string }>('select provider_ref from contract_sessions where session_id = $1', [b.sessionId]);
        if (!r.rows[0]) return { ok: false };
        if (ctx.esign instanceof MockESign) await ctx.esign.complete(r.rows[0].provider_ref, b.outcome);
        return s.refresh(b.sessionId);
      },
    });
  }
}

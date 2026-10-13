import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { IdentityService, applicationCreateSchema, signerKeyAddressSchema, signerKeyChallengeSchema, signerKeyLinkSchema } from './service.ts';

/** Stored idempotency replays carry no decrypted application notes (they stay in the vault only). */
const withoutNotes = (r: Record<string, unknown>): Record<string, unknown> => ('notes' in r ? { ...r, notes: null } : r);

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

  // attestor keys (S4 WP7, D4): a key is linked to the account by its own EIP-191 proof, never by a chain wallet
  defineRoute(app, ctx, { method: 'POST', url: '/me/signer-keys/challenge', access: 'account', handler: async (req, _reply, session) => s.signerKeyChallenge(session!, signerKeyChallengeSchema.parse(req.body).address) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/me/signer-keys', access: 'account',
    handler: async (req, reply, session) => {
      const r = await s.linkSignerKey(session!, signerKeyLinkSchema.parse(req.body));
      reply.status(r.created ? 201 : 200);
      return r;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/me/signer-keys', access: 'account', handler: async (_req, _reply, session) => ({ keys: await s.signerKeys(session!.accountId) }) });
  defineRoute(app, ctx, { method: 'DELETE', url: '/me/signer-keys/:address', access: 'account', handler: async (req, _reply, session) => s.unlinkSignerKey(session!, signerKeyAddressSchema.parse((req.params as { address: string }).address)) });
  // the account's attestor identity check (A-SIG-7): an admin's registration of a key linked to the account needs it passed
  defineRoute(app, ctx, { method: 'POST', url: '/me/attestor/identity-check', access: 'account', handler: async (_req, _reply, session) => s.startAttestorIdentityCheck(session!.accountId) });
  defineRoute(app, ctx, { method: 'GET', url: '/me/attestor/identity-check', access: 'account', handler: async (_req, _reply, session) => s.attestorIdentityCheck(session!.accountId) });

  defineRoute(app, ctx, {
    method: 'POST', url: '/applications', access: 'account',
    handler: async (req, reply, session) => {
      const body = applicationCreateSchema.parse(req.body);
      // replays never carry the decrypted notes: the stored copy has them nulled (GET /applications/{id} returns them)
      const r = await withIdempotency(ctx.pool, `applications:${session!.accountId}`, idem(req), body, async () => ({ status: 201, response: await s.createApplication(session!, body) }), { store: withoutNotes });
      reply.status(r.status);
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/applications/mine', access: 'account', handler: async (_req, _reply, session) => ({ applications: await s.listMine(session!) }) });
  defineRoute(app, ctx, { method: 'POST', url: '/applications/:applicationId/identity/trial', access: 'account', handler: async (req, _reply, session) => {
    z.object({ acknowledgeSynthetic: z.literal(true) }).strict().parse(req.body);
    return s.completeTrialIdentity((req.params as { applicationId: string }).applicationId, session!);
  } });
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
      const r = await withIdempotency(ctx.pool, `decide:${session!.accountId}`, idem(req), { id: (req.params as { applicationId: string }).applicationId, ...b }, async () => ({ status: 200, response: await s.decide((req.params as { applicationId: string }).applicationId, session!, b.decision, b.reasonCode) }), { store: withoutNotes });
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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { NotificationsService, preferencesSchema } from './service.ts';

export function registerNotificationsRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new NotificationsService(ctx);
  const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;
  const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

  defineRoute(app, ctx, {
    method: 'GET', url: '/me/notifications', access: 'account',
    handler: async (req, _reply, session) => {
      const q = z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return s.list(session!, { unread: q.unread === 'true', limit: q.limit });
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/me/notifications/read', access: 'account',
    handler: async (req, _reply, session) => {
      const b = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) }).parse(req.body);
      const r = await withIdempotency(ctx.pool, `notifications.read:${session!.accountId}`, idem(req), b, async () => ({ status: 200, response: await s.markRead(session!, b.ids) }));
      return r.response;
    },
  });
  defineRoute(app, ctx, { method: 'GET', url: '/me/notification-preferences', access: 'account', handler: async (_req, _reply, session) => s.getPreferences(session!) });
  defineRoute(app, ctx, {
    method: 'PUT', url: '/me/notification-preferences', access: 'account',
    handler: async (req, _reply, session) => {
      const b = preferencesSchema.parse(req.body);
      const r = await withIdempotency(ctx.pool, `notification-preferences:${session!.accountId}`, idem(req), b, async () => ({ status: 200, response: await s.setPreferences(session!, b) }));
      return r.response;
    },
  });

  defineRoute(app, ctx, { method: 'GET', url: '/admin/notifications/outbox', access: 'admin', handler: async (_req, _reply, session) => s.adminOutbox(session!) });
  defineRoute(app, ctx, { method: 'GET', url: '/admin/notifications/emails', access: 'admin', handler: async (req, _reply, session) => s.adminEmails(session!, limitQuery.parse(req.query).limit) });
}

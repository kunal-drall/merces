import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { AppError } from '@merces/core';
import { ChainError } from '@merces/domain';
import type { AppContext } from './context.ts';
import { verifySession, type Session } from './auth/session.ts';
import { requireTier, type AccessTier } from './auth/access.ts';
import { registerPublicRoutes } from './routes/public.ts';
import { registerMeRoutes } from './routes/me.ts';
import { registerDevRoutes } from './routes/dev.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyContextConfig {
    access?: AccessTier;
    devOnly?: boolean;
  }
}

export interface RouteDef<Q = unknown, B = unknown> {
  bodyLimit?: number;
  method: HTTPMethods;
  url: string;
  access: AccessTier;
  devOnly?: boolean;
  handler: (req: FastifyRequest, reply: FastifyReply, session: Session | null) => Promise<Q | B>;
}

/** Every route declares its access tier here; app.routes() exposes the table for the OpenAPI check and the matrix test. */
export function defineRoute(app: FastifyInstance, ctx: AppContext, def: RouteDef): void {
  app.route({
    method: def.method,
    url: def.url,
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    config: { access: def.access, devOnly: def.devOnly ?? false },
    handler: async (req, reply) => {
      const session = await requireTier(ctx, req, reply, def.access);
      const out = await def.handler(req, reply, session);
      return out;
    },
  });
}

export type RouteRegistrar = (app: FastifyInstance, ctx: AppContext) => void;

export async function buildApp(ctx: AppContext, extraRoutes: RouteRegistrar[] = []): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  trackRoutes(app);
  await app.register(cors, { origin: true });

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.session = null;
    if (h?.startsWith('Bearer ')) req.session = verifySession(ctx.sessionSecret, h.slice(7));
  });

  app.setErrorHandler((errUnknown: unknown, _req, reply) => {
    const err = errUnknown as Error & { statusCode?: number };
    // Form parse/storage failures may contain submitted values; never echo or log their details.
    if (_req.url.startsWith('/forms/') || _req.url.startsWith('/operator/') || _req.url.includes('/verifier-jobs')) {
      const status = err instanceof AppError ? err.status : (err.statusCode ?? 500);
      return reply.status(status).send({ error: status >= 500 ? 'Unavailable' : 'Rejected', message: _req.url.startsWith('/forms/') ? 'form request could not be accepted' : 'private request could not be accepted', detail: null });
    }
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail ?? null });
    if (err instanceof ChainError) {
      const status = err.code === 'NotFound' ? 404 : err.code === 'Unauthorized' || err.code === 'NotAllowlisted' || err.code === 'NotPermitted' ? 403 : err.code === 'NotImplemented' ? 501 : 422;
      return reply.status(status).send({ error: `Chain${err.code}`, message: err.message, detail: err.detail ?? null });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: 'BadRequest', message: 'validation failed', detail: { issues: err.issues } });
    const status = err.statusCode ?? 500;
    if (status >= 500) ctx.log.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return reply.status(status).send({ error: status >= 500 ? 'Internal' : 'BadRequest', message: status >= 500 ? 'internal error' : err.message, detail: null });
  });

  registerPublicRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  if (ctx.devMode) registerDevRoutes(app, ctx);
  for (const r of extraRoutes) r(app, ctx);
  return app;
}

/** List registered routes with their access tiers (for the OpenAPI check and tests). */
export function routeTable(app: FastifyInstance): { method: string; url: string; access: AccessTier; devOnly: boolean }[] {
  return [...(registered.get(app) ?? [])];
}

const registered = new WeakMap<FastifyInstance, { method: string; url: string; access: AccessTier; devOnly: boolean }[]>();
export function trackRoutes(app: FastifyInstance): void {
  const list: { method: string; url: string; access: AccessTier; devOnly: boolean }[] = [];
  registered.set(app, list);
  app.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      list.push({ method: m, url: opts.url, access: (opts.config as { access?: AccessTier } | undefined)?.access ?? 'public', devOnly: (opts.config as { devOnly?: boolean } | undefined)?.devOnly ?? false });
    }
  });
}

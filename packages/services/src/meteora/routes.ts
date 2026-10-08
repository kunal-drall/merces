import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { MockDex, MockMeteora, type DexPort, type MeteoraPort } from '@merces/ports';
import { svc } from '../context.ts';
import { MeteoraService } from './service.ts';

export interface MeteoraProviders {
  meteora?: MeteoraPort;
  dex?: DexPort;
}

/** Shared mock instances so tests and dev:mock can mirror simulator buys into the mock pool. */
export const defaultMeteoraProviders: { meteora: MockMeteora; dex: MockDex } = { meteora: new MockMeteora(), dex: new MockDex() };

export function registerMeteoraRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new MeteoraService(ctx, defaultMeteoraProviders.meteora, defaultMeteoraProviders.dex);
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/curve', access: 'public', handler: async (req) => s.status(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/curve/configure', access: 'issuer', handler: async (req, _r, session) => s.configure(sid(req), session!) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/curve/build-buy', access: 'backer',
    handler: async (req, _r, session) => {
      const b = z.object({ buyer: z.string(), amountIn: z.string().regex(/^\d+$/), payIn: z.enum(['USDC', 'USDG']).default('USDC'), slippageBps: z.number().int().min(0).max(1000).default(50) }).parse(req.body);
      return s.buildBuy(sid(req), session!, b.buyer, b.amountIn, b.payIn, b.slippageBps);
    },
  });
  defineRoute(app, ctx, { method: 'POST', url: '/admin/curves/monitor', access: 'admin', handler: async () => s.monitorGraduation() });
}

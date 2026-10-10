import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { MockDex, MockMeteora, type DexPort, type MeteoraPort } from '@merces/ports';
import { svc } from '../context.ts';
import { MeteoraService } from './service.ts';
import { CurveStakingService } from './staking.ts';

export interface MeteoraProviders {
  meteora?: MeteoraPort;
  dex?: DexPort;
}

/** Shared mock instances so tests and dev:mock can mirror simulator buys into the mock pool. */
export const defaultMeteoraProviders: { meteora: MockMeteora; dex: MockDex } = { meteora: new MockMeteora(), dex: new MockDex() };

export function registerMeteoraRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new MeteoraService(ctx, defaultMeteoraProviders.meteora, defaultMeteoraProviders.dex);
  const staking = new CurveStakingService(ctx);
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/curve', access: 'public', handler: async (req) => s.status(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/curve/configure', access: 'issuer', handler: async (req, _r, session) => s.configure(sid(req), session!) });
  const swapInput = {
    wallet: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    amountIn: z.string().regex(/^\d+$/),
    payIn: z.enum(['USDC', 'USDG']).default('USDC'),
    slippageBps: z.coerce.number().int().min(0).max(1000).default(50),
  };
  // the pre-buy (or pre-sell) quote: the chain's quote, earns, and the statements a buyer acknowledges before a buy
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/curve/quote', access: 'account', handler: async (req, _r, session) => s.quoteSwap(sid(req), session!, z.object(swapInput).parse(req.query)) });
  // a trade on the curve (replaces build-buy): a buy needs an eligible backer and the acknowledgement; a sell any linked wallet
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/curve/build-swap', access: 'account',
    handler: async (req, _r, session) => s.buildSwap(sid(req), session!, z.object({ ...swapInput, acknowledged: z.boolean().optional(), beforeYouBuyVersion: z.string().optional() }).parse(req.body)),
  });
  // curve staking (S3 WP12): every builder on the account tier with the wallet linked (a buyer has no position row until it stakes)
  const units = z.string().regex(/^\d+$/);
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/curve/position', access: 'account', handler: async (req, _r, session) => staking.walletPositions(sid(req), session!, z.object({ wallet: z.string().min(1).optional() }).parse(req.query).wallet) });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/curve/build-stake', access: 'account',
    handler: async (req, _r, session) => {
      const b = z.object({ wallet: z.string().min(1), units }).parse(req.body);
      return staking.buildStake(sid(req), session!, b.wallet, b.units);
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/curve/build-unstake', access: 'account',
    handler: async (req, _r, session) => {
      const b = z.object({ wallet: z.string().min(1), units }).parse(req.body);
      return staking.buildUnstake(sid(req), session!, b.wallet, b.units);
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/series/:seriesId/curve/build-tender', access: 'account',
    handler: async (req, _r, session) => {
      const b = z.object({ wallet: z.string().min(1), fromStake: units.default('0'), fromWallet: units.default('0') }).parse(req.body);
      return staking.buildTender(sid(req), session!, b.wallet, b.fromStake, b.fromWallet);
    },
  });
  // the census is permissionless: any signed-in account builds it for one of its own wallets
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/curve/build-sync', access: 'account', handler: async (req, _r, session) => s.buildSync(sid(req), session!, z.object({ signer: z.string().min(1) }).parse(req.body).signer) });
  defineRoute(app, ctx, { method: 'POST', url: '/admin/curves/monitor', access: 'admin', handler: async () => s.monitorGraduation() });
}

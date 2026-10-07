import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@merces/core';
import { SimulatorChain } from '@merces/simulator';
import { defineRoute } from '../app.ts';
import type { AppContext } from '../context.ts';

/** Mock-mode only: time travel and a faucet so Stage 3 can drive the whole lifecycle locally. Never registered in live mode. */
export function registerDevRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sims = () => [...ctx.chains.chains.values()].filter((c): c is SimulatorChain => c instanceof SimulatorChain);

  defineRoute(app, ctx, {
    method: 'GET', url: '/dev/time', access: 'public', devOnly: true,
    handler: async () => ({ chains: await Promise.all(sims().map(async (s) => ({ chain: s.chain, now: await s.now(), iso: new Date((await s.now()) * 1000).toISOString() }))) }),
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/dev/advance-time', access: 'public', devOnly: true,
    handler: async (req) => {
      const b = z.object({ seconds: z.number().int().positive().max(10 * 365 * 86_400) }).parse(req.body);
      const out = [];
      for (const s of sims()) out.push({ chain: s.chain, now: await s.advanceTime(b.seconds) });
      return { chains: out };
    },
  });
  defineRoute(app, ctx, {
    method: 'POST', url: '/dev/faucet', access: 'public', devOnly: true,
    handler: async (req) => {
      const b = z.object({ chain: z.string(), wallet: z.string(), stablecoin: z.enum(['USDC', 'USDG']), amount: z.string().regex(/^\d+$/) }).parse(req.body);
      const s = sims().find((x) => x.chain === b.chain);
      if (!s) throw AppError.notFound('simulator chain');
      await s.fund(b.wallet, b.stablecoin, BigInt(b.amount));
      return { balance: await s.getBalance(b.wallet, b.stablecoin) };
    },
  });
}

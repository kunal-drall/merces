import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute, type AppContext } from '@merces/api';
import { svc } from '../context.ts';
import { AuctionService, precheckSchema } from './service.ts';

export function registerAuctionRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const s = new AuctionService(ctx);
  const sid = (req: { params: unknown }) => (req.params as { seriesId: string }).seriesId;
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/bids/precheck', access: 'backer', handler: async (req, _r, session) => s.precheck(sid(req), session!, precheckSchema.parse(req.body)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/bids/commitment', access: 'backer', handler: async (req) => {
    const b = z.object({ bidder: z.string(), pricePerUnit: z.string().regex(/^\d+$/), quantity: z.string().regex(/^\d+$/), salt: z.string() }).parse(req.body);
    return s.commitment(sid(req), b.bidder, b.pricePerUnit, b.quantity, b.salt);
  } });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/bids/build-commit', access: 'backer', handler: async (req, _r, session) => {
    const b = z.object({ bidder: z.string(), commitment: z.string().regex(/^0x[0-9a-f]{64}$/), deposit: z.string().regex(/^\d+$/) }).parse(req.body);
    return s.buildCommit(sid(req), session!, b.bidder, b.commitment, b.deposit);
  } });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/bids/build-reveal', access: 'backer', handler: async (req, _r, session) => {
    const b = z.object({ bidder: z.string(), pricePerUnit: z.string().regex(/^\d+$/), quantity: z.string().regex(/^\d+$/), salt: z.string() }).parse(req.body);
    return s.buildReveal(sid(req), session!, b.bidder, b.pricePerUnit, b.quantity, b.salt);
  } });
  // every settlement step is permissionless: any signed-in account builds them for one of its own wallets
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/bids/build-deliver', access: 'account', handler: async (req, _r, session) => {
    const b = z.object({ bidder: z.string().min(1), signer: z.string().min(1).optional() }).parse(req.body);
    return s.buildDeliver(sid(req), session!, b.bidder, b.signer);
  } });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/auction/build-step', access: 'account', handler: async (req, _r, session) => s.buildSettlementStep(sid(req), session!, z.object({ signer: z.string().min(1) }).parse(req.body).signer) });
  // the issuer opens and cancels its own raise
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/raise/build-open', access: 'issuer', handler: async (req) => s.buildOpenRaise(sid(req)) });
  defineRoute(app, ctx, { method: 'POST', url: '/series/:seriesId/raise/build-cancel', access: 'issuer', handler: async (req) => s.buildCancelRaise(sid(req)) });
  defineRoute(app, ctx, { method: 'PUT', url: '/series/:seriesId/bids/backup', access: 'backer', handler: async (req, _r, session) => {
    const b = z.object({ bidder: z.string(), ciphertext: z.string().min(1), keyHint: z.string().max(200).nullable().default(null) }).parse(req.body);
    return s.putBackup(sid(req), session!, b.bidder, b.ciphertext, b.keyHint);
  } });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/bids/backup/:bidder', access: 'account', handler: async (req, _r, session) => s.getBackup(sid(req), session!, (req.params as { bidder: string }).bidder) });
  defineRoute(app, ctx, { method: 'GET', url: '/series/:seriesId/auction/preview', access: 'public', handler: async (req) => s.preview(sid(req)) });
}

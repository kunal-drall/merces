import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@merces/core';
import { defineRoute, type AppContext, type Session } from '@merces/api';
import { svc } from '../context.ts';

export function registerRouterRoutes(app: FastifyInstance, base: AppContext): void {
  const ctx = svc(base);
  const sid = (req: {params:unknown}) => (req.params as {seriesId:string}).seriesId;
  const payer = z.object({wallet:z.string().min(1)});
  const linked = (session: Session,chain:string,wallet:string) => {
    if (!session.wallets.some((w)=>w.chain===chain && w.address===wallet)) throw AppError.forbidden('wallet is not linked to your account');
  };
  defineRoute(app,ctx,{method:'GET',url:'/series/:seriesId/router',access:'issuer',handler:async(req,_r,session)=> {
    const chain = ctx.chainFor(sid(req)), s = await chain.getSeries(sid(req));
    if (!s) throw AppError.notFound('series');
    linked(session!,chain.chain,s.issuer);
    const router = await chain.getRouter(s.seriesId);
    if (!router) throw AppError.conflict('tier-1 router is not enabled',{stage1:'RouterNotEnabled'});
    return {router,terms:s.terms.routerTerms,routerCredit:s.trueUp.routerCredit,mintFinalized:s.mintFinalized};
  }});
  defineRoute(app,ctx,{method:'POST',url:'/series/:seriesId/router/build-route',access:'account',handler:async(req,_r,session)=> {
    const b = payer.extend({amount:z.string().regex(/^\d+$/)}).parse(req.body), chain = ctx.chainFor(sid(req));
    linked(session!,chain.chain,b.wallet);
    return {tx:await chain.build({kind:'routeIncome',seriesId:sid(req),amount:b.amount},b.wallet)};
  }});
  defineRoute(app,ctx,{method:'POST',url:'/series/:seriesId/router/build-sweep',access:'account',handler:async(req,_r,session)=> {
    const b = payer.parse(req.body),chain = ctx.chainFor(sid(req)); linked(session!,chain.chain,b.wallet);
    return {tx:await chain.build({kind:'sweepRouter',seriesId:sid(req)},b.wallet)};
  }});
  defineRoute(app,ctx,{method:'POST',url:'/series/:seriesId/router/build-close',access:'account',handler:async(req,_r,session)=> {
    const b = payer.extend({periodId:z.string().regex(/^\d{4}Q[1-4]$/)}).parse(req.body),chain = ctx.chainFor(sid(req)); linked(session!,chain.chain,b.wallet);
    return {tx:await chain.build({kind:'closeRouterPeriod',seriesId:sid(req),periodId:b.periodId},b.wallet)};
  }});
  defineRoute(app,ctx,{method:'POST',url:'/issuers/build-issuance',access:'issuer',handler:async(req,_r,session)=> {
    const b = payer.extend({chain:z.string(),stopped:z.boolean()}).parse(req.body),chain = ctx.chains.get(b.chain); linked(session!,chain.chain,b.wallet);
    return {tx:await chain.build({kind:b.stopped?'stopIssuance':'resumeIssuance'},b.wallet)};
  }});
}

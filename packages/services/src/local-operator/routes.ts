import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { defineRoute, type AppContext } from '@merces/api';
import { AppError, audit, withIdempotency } from '@merces/core';
import { svc } from '../context.ts';
import { envelopeSchema, sameWallet } from './policy.ts';
import type { VerifierKeyInfo } from '@merces/report-verifier';

export function registerLocalOperatorRoutes(app:FastifyInstance,base:AppContext) {
  const ctx=svc(base), operator=()=>{if(!ctx.localOperator)throw new AppError(503,'Unavailable','local operator is not configured');return ctx.localOperator;};
  defineRoute(app,ctx,{method:'GET',url:'/operator/status',access:'public',handler:async()=>{
    const {online,lastSeenAt}=await operator().status();return {online,lastSeenAt,custody:'local',testOnly:true};
  }});
  defineRoute(app,ctx,{method:'POST',url:'/admin/keepers/crank-status',access:'admin',handler:async(req,_reply,session)=>{
    const b=z.object({chain:z.enum(['solana','monad']),seriesId:z.string().max(160)}).strict().parse(req.body);
    const result=await withIdempotency(ctx.pool,'operator-status:'+session!.accountId,req.headers['idempotency-key'] as string|undefined,b,async()=>{
      const receipt=await operator().submit(b.chain,{kind:'crankStatus',seriesId:b.seriesId},'keeper');
      await audit(ctx.pool,{actor:session!.accountId,actorRole:'admin',action:'keeper.status-cranked',target:b.seriesId,detail:{chain:b.chain,txId:receipt.txId,testOnly:true}});
      return {status:200,response:{txId:receipt.txId,blockTime:receipt.blockTime}};
    });
    return result.response;
  }});
  // Dedicated operator credential; no browser session or onchain key is used here.
  defineRoute(app,ctx,{method:'POST',url:'/operator/poll',access:'public',bodyLimit:16384,handler:async req=>{
    const op=operator();op.authenticate(req.headers.authorization);
    const body=z.object({claim:z.boolean().optional(),verifier:z.object({transport:z.object({kind:z.literal('local-operator-v1'),encryptionSignature:z.string().regex(/^0x[0-9a-f]{130}$/),encryptionKey:z.object({kty:z.literal('RSA'),n:z.string(),e:z.literal('AQAB')}).strict()}),address:z.string(),publicKeyHex:z.string(),chains:z.array(z.object({chain:z.string(),domain:z.object({chainKind:z.number(),chainId:z.string(),registry:z.string(),domain:z.string()})})).length(2),previous:z.array(z.object({address:z.string(),retiredAt:z.number()})),syntheticIncome:z.object({testOnly:z.literal(true),notice:z.string()})})}).strict().parse(req.body);
    return op.poll(body.verifier as VerifierKeyInfo,body.claim);
  }});
  defineRoute(app,ctx,{method:'POST',url:'/operator/jobs/:jobId/complete',access:'public',bodyLimit:800000,handler:async req=>{
    const op=operator();op.authenticate(req.headers.authorization);
    const b=z.object({lease:z.string().uuid(),result:z.unknown().optional(),errorCode:z.string().regex(/^[a-z0-9-]{1,64}$/).optional()}).strict().parse(req.body);
    return op.finish(z.string().uuid().parse((req.params as {jobId:string}).jobId),b.lease,b.result,b.errorCode);
  }});
  defineRoute(app,ctx,{method:'POST',url:'/series/:seriesId/verifier-jobs',access:'issuer',bodyLimit:750000,handler:async(req,_reply,session)=>{
    const b=z.object({id:z.string().uuid(),envelope:envelopeSchema}).strict().parse(req.body),seriesId=(req.params as {seriesId:string}).seriesId;
    if(!operator().policy.series.includes(seriesId))throw AppError.forbidden('series is outside the local operator policy');
    return operator().enqueueVerifier(session!.accountId,b.id,{seriesId,envelope:b.envelope});
  }});
  defineRoute(app,ctx,{method:'GET',url:'/operator/verifier-jobs/:jobId',access:'account',handler:async(req,_reply,session)=>operator().reply(session!.accountId,z.string().uuid().parse((req.params as {jobId:string}).jobId))});
  defineRoute(app,ctx,{method:'POST',url:'/admin/applications/:applicationId/test-identity',access:'admin',handler:async(req,_reply,session)=>{
    z.object({acknowledgeSynthetic:z.literal(true)}).strict().parse(req.body);
    const id=(req.params as {applicationId:string}).applicationId;
    const a=(await ctx.pool.query('select chain,wallet,state from applications where application_id=$1',[id])).rows[0];
    if(!a || !operator().policy.wallets.some(w=>w.chain===a.chain&&sameWallet(a.chain,w.address,a.wallet)) || !['draft','submitted','in_review'].includes(a.state))throw AppError.forbidden('only configured disposable test accounts are eligible');
    await ctx.pool.query("update applications set identity_check_id=$2,identity_status='passed',updated_at=now() where application_id=$1",[id,'operator-testnet:'+id]);
    await audit(ctx.pool,{actor:session!.accountId,actorRole:'admin',action:'identity.synthetic-test-reviewed',target:id,detail:{testOnly:true,realIdentityVerified:false}});
    return {status:'passed',testOnly:true,realIdentityVerified:false};
  }});
}

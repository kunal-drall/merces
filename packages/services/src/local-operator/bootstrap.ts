import { sameWallet } from './policy.ts';
import { z } from 'zod';
import { audit } from '@merces/core';
import type { ServiceContext } from '../context.ts';

/** A pinned operator wallet must complete the normal nonce/signature login before the first grant. */
export async function bootstrapOperator(ctx:ServiceContext,accountId:string,chain:string,address:string) {
  if(!ctx.localOperator) return;
  const wallets=z.array(z.object({chain:z.enum(['solana','monad']),address:z.string().min(20)}).strict()).max(2).parse(JSON.parse(process.env.MERCES_BOOTSTRAP_ADMIN_WALLETS??'[]'));
  if(!wallets.some(w=>w.chain===chain&&sameWallet(chain,w.address,address)))return;
  const r=await ctx.pool.query("update accounts set roles=array_append(roles,'admin') where account_id=$1 and not ('admin'=any(roles)) returning account_id",[accountId]);
  if(r.rowCount)await audit(ctx.pool,{actor:accountId,actorRole:'admin',action:'operator.bootstrap-wallet-proof',target:accountId,detail:{chain,wallet:address,testOnly:true}});
}

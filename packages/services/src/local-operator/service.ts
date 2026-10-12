import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@merces/core';
import { ChainError, recoverSigner, type ServiceRole, type TxResult, type SigningDomain } from '@merces/domain';
import type { ServiceContext } from '../context.ts';
import type { VerifierKeyInfo } from '@merces/report-verifier';
import { envelopeSchema, operatorCommand, operatorPolicySchema, type OperatorPolicy } from './policy.ts';

export class LocalOperator {
  private domains?: {chain:string;domain:SigningDomain}[];
  readonly policy: OperatorPolicy;
  readonly encryptionKey: {kty:'RSA';n:string;e:'AQAB'};
  constructor(private ctx: ServiceContext, private token: string, policy: unknown, encryptionKey: unknown, private address: string) {
    this.policy=operatorPolicySchema.parse(policy);
    this.encryptionKey=z.object({kty:z.literal('RSA'),n:z.string().min(300),e:z.literal('AQAB')}).strict().parse(encryptionKey);
    if(token.length<48 || !/^0x[0-9a-f]{40}$/.test(address)) throw Error('Local operator configuration is incomplete');
  }
  authenticate(value: unknown) {
    const actual=Buffer.from(typeof value==='string'?value:''), expected=Buffer.from('Bearer '+this.token);
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw AppError.unauthorized('operator authentication required');
  }
  async status() {
    const row=(await this.ctx.pool.query('select seen_at,verifier from local_operator_heartbeat where singleton')).rows[0];
    return {online:!!row && Date.now()-new Date(row.seen_at).getTime()<30000,lastSeenAt:row?.seen_at??null,verifier:row?.verifier??null};
  }
  async keys(): Promise<VerifierKeyInfo> {
    const state=await this.status();
    if(!state.online || !state.verifier) throw new AppError(503,'Unavailable','local operator is offline');
    return {...state.verifier,transport:{kind:'local-operator-v1',encryptionKey:this.encryptionKey,encryptionSignature:state.verifier.transport.encryptionSignature}};
  }
  async poll(info: VerifierKeyInfo, claim=true) {
    if(info.address!==this.address || !info.syntheticIncome?.testOnly) throw AppError.forbidden('operator key or provider mismatch');
    const digest='0x'+createHash('sha256').update('merces/local-verifier-key/v1:'+JSON.stringify(this.encryptionKey)).digest('hex');
    if(!info.transport || recoverSigner(digest,info.transport.encryptionSignature)!==this.address)throw AppError.forbidden('operator encryption key mismatch');
    const expected=this.domains??=await Promise.all([...this.ctx.chains.chains.values()].map(async c=>{const domain=(await c.info()).signing;if(!domain)throw AppError.forbidden('operator signing domain missing');return {chain:c.chain,domain};}));
    if(expected.some(e=>!(e.chain==='solana'&&e.domain.chainKind===1&&e.domain.chainId==='103'||e.chain==='monad'&&e.domain.chainKind===2&&e.domain.chainId==='10143')))throw AppError.forbidden('operator test networks required');
    if(expected.length!==info.chains.length || expected.some(e=>!info.chains.some(c=>c.chain===e.chain && ['chainKind','chainId','registry','domain'].every(k=>(c.domain as unknown as Record<string,unknown>)[k]===(e.domain as unknown as Record<string,unknown>)[k])))) throw AppError.forbidden('operator network mismatch');
    await this.ctx.pool.query('insert into local_operator_heartbeat(singleton,seen_at,verifier) values(true,now(),$1) on conflict(singleton) do update set seen_at=now(),verifier=excluded.verifier',[JSON.stringify(info)]);
    // Expired encrypted payloads are removed promptly, not retained as operational history.
    await this.ctx.pool.query("delete from local_operator_jobs where kind='verifier' and expires_at<now() or completed_at<now()-interval '1 day'");
    if(!claim)return {job:null};
    const lease=randomUUID();
    const job=(await this.ctx.pool.query("update local_operator_jobs set status='leased',lease=$1,leased_until=now()+interval '90 seconds' where id=(select id from local_operator_jobs where expires_at>now() and (status='pending' or status='leased' and leased_until<now()) order by created_at for update skip locked limit 1) returning id,kind,payload,lease,expires_at",[lease])).rows[0];
    return {job:job??null};
  }
  async finish(id:string,lease:string,result:unknown,errorCode?:string) {
    const r=await this.ctx.pool.query("update local_operator_jobs set status=$3,result=$4,error_code=$5,completed_at=now() where id=$1 and lease=$2 and status='leased'",[id,lease,errorCode?'failed':'complete',result===undefined?null:JSON.stringify(result),errorCode??null]);
    return {accepted:!!r.rowCount};
  }
  async enqueueVerifier(owner:string,id:string,payload:{seriesId:string;envelope:z.infer<typeof envelopeSchema>}) {
    if(!(await this.status()).online) throw new AppError(503,'Unavailable','local operator is offline');
    const pending=await this.ctx.pool.query("select 1 from local_operator_jobs where owner=$1 and expires_at>now() and status in ('pending','leased')",[owner]);
    if(pending.rowCount) throw AppError.conflict('a verifier request is already pending');
    await this.ctx.pool.query("insert into local_operator_jobs(id,owner,kind,payload,expires_at) values($1,$2,'verifier',$3,now()+interval '3 minutes') on conflict(id) do nothing",[id,owner,JSON.stringify(payload)]);
    return {id};
  }
  async reply(owner:string,id:string) {
    const row=(await this.ctx.pool.query('select status,result,error_code from local_operator_jobs where id=$1 and owner=$2 and expires_at>now()',[id,owner])).rows[0];
    if(!row) throw AppError.notFound('operator request');
    return {status:row.status,result:row.result,errorCode:row.error_code};
  }
  async submit(chain:string,input:unknown,role:ServiceRole): Promise<TxResult> {
    const command=operatorCommand(this.policy,chain,role,input);
    if(!(await this.status()).online) throw new ChainError('Unauthorized','local operator is offline; no transaction signed');
    const id=randomUUID();
    await this.ctx.pool.query("insert into local_operator_jobs(id,kind,payload,expires_at) values($1,'service',$2,now()+interval '3 minutes')",[id,JSON.stringify({chain,role,command})]);
    for(let i=0;i<240;i++) {
      const row=(await this.ctx.pool.query('select status,result,error_code from local_operator_jobs where id=$1',[id])).rows[0];
      if(row?.status==='complete') return row.result as TxResult;
      if(row?.status==='failed') throw new ChainError('ChainSpecific','local operator refused the transaction',{operatorCode:row.error_code});
      await new Promise(r=>setTimeout(r,500));
    }
    throw new ChainError('ChainSpecific','local operator transaction outcome is pending; reconcile before retry');
  }
}

export function localOperatorFromEnv(ctx:ServiceContext,env:NodeJS.ProcessEnv=process.env) {
  if(env.MERCES_LOCAL_OPERATOR!=='true') return undefined;
  if([...ctx.chains.chains.values()].some(c=>c.mode!=='live') || ctx.chains.chains.size!==2) throw Error('Local operator requires both pinned live test networks');
  return new LocalOperator(ctx,env.MERCES_LOCAL_OPERATOR_TOKEN??'',JSON.parse(env.MERCES_LOCAL_OPERATOR_POLICY??'null'),JSON.parse(env.MERCES_LOCAL_OPERATOR_PUBLIC_KEY??'null'),env.REPORT_VERIFIER_ADDRESS??'');
}

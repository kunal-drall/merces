import { randomUUID } from 'node:crypto';
import { ReclaimProofRequest, verifyProof, type Proof, type VerificationConfig } from '@reclaimprotocol/js-sdk';
import { parsePeriod } from '@merces/math';
import type { ZkTlsPort, ZkTlsProof, ZkTlsVerification, IncomeSourceKind } from './zktls.ts';

export interface ReclaimSession {
  id:string; nonce:string; message:string; seriesId:string; periodId:string; accountId:string;
  createdAt:number; expiresAt:number; coversUntil:number; providerId:string; providerVersion:string;
}
/** Must be durable and atomically spend a session across concurrent verifier requests. Stores no income or proof. */
export interface ReclaimSessionStore {
  put(session:ReclaimSession):Promise<void>;
  get(id:string):Promise<ReclaimSession|null>;
  consume(id:string):Promise<boolean>;
}
export interface ReclaimConfig {
  appId:string; appSecret:string;
  /** A reviewed custom Stripe YTD provider. The catalogue's last-transaction provider is refused. */
  providerId:string; providerVersion:string;
  seriesAccounts:Record<string,string>;
  store:ReclaimSessionStore;
}
export interface ReclaimSdk {
  init:typeof ReclaimProofRequest.init;
  verify:(proofs:Proof[],config:VerificationConfig)=>ReturnType<typeof verifyProof>;
}

/** Client proofs reach this adapter only in the local verifier, through its encrypted relay. */
export class ReclaimZkTls implements ZkTlsPort {
  readonly provider='reclaim' as const;
  constructor(private cfg:ReclaimConfig, private sdk:ReclaimSdk={init:ReclaimProofRequest.init.bind(ReclaimProofRequest),verify:verifyProof}, private now=()=>Math.floor(Date.now()/1000)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.appId) || !/^0x[0-9a-fA-F]{64}$/.test(cfg.appSecret) || !/^[0-9a-f-]{36}$/.test(cfg.providerId) || !/^\d+\.\d+\.\d+$/.test(cfg.providerVersion) || cfg.providerId==='acfdeaa9-9250-4acd-afd3-fac7ca03458b') throw Error('reclaim-reviewed-provider-required');
  }
  async createSession(params:{source:IncomeSourceKind;seriesId:string;periodId:string;coversUntil:number;year:number}) {
    const period=parsePeriod(params.periodId),accountId=this.cfg.seriesAccounts[params.seriesId];
    if(params.source!=='stripe'||!accountId||!/^acct_[A-Za-z0-9]+$/.test(accountId)||period.end!==params.coversUntil||period.year!==params.year||period.end>this.now())throw Error('reclaim-source-context-refused');
    const nonce=randomUUID(),message=JSON.stringify({v:1,source:'stripe',seriesId:params.seriesId,periodId:params.periodId,yearStart:Date.UTC(period.year,0,1)/1000,coversUntil:period.end,accountId});
    const req=await this.sdk.init(this.cfg.appId,this.cfg.appSecret,this.cfg.providerId,{providerVersion:this.cfg.providerVersion,acceptAiProviders:false,acceptTeeAttestation:true,log:false});
    req.setContext(nonce,message);
    req.setParams({accountId,yearStart:String(Date.UTC(period.year,0,1)/1000),coversUntil:String(period.end)});
    const version=req.getProviderVersion();
    if(version.providerId!==this.cfg.providerId||version.providerVersion!==this.cfg.providerVersion)throw Error('reclaim-provider-version-mismatch');
    const sessionId=req.getSessionId();
    const result={sessionId,requestUrl:await req.getRequestUrl(),statusUrl:req.getStatusUrl()};
    await this.cfg.store.put({id:sessionId,nonce,message,seriesId:params.seriesId,periodId:params.periodId,accountId,createdAt:this.now(),expiresAt:this.now()+900,coversUntil:period.end,...version});
    return result;
  }
  async verify(input:ZkTlsProof,expect:{seriesId:string;periodId:string}):Promise<ZkTlsVerification> {
    const fail=():ZkTlsVerification=>({ok:false,source:'stripe',figure:null,figureHash:null,currency:'',coversUntil:0,sessionId:'',providerHash:'',error:'reclaim-proof-refused'});
    try {
      // The envelope's sessionId is only a lookup key, never evidence by itself.
      const envelope=input as unknown as {sessionId:string;proofs:Proof[]};
      if(typeof envelope.sessionId!=='string'||!Array.isArray(envelope.proofs)||envelope.proofs.length!==1)return fail();
      const session=await this.cfg.store.get(envelope.sessionId);
      if(!session||session.expiresAt<this.now()||session.seriesId!==expect.seriesId||session.periodId!==expect.periodId||session.accountId!==this.cfg.seriesAccounts[expect.seriesId])return fail();
      const checked=await this.sdk.verify(envelope.proofs,{providerId:session.providerId,providerVersion:session.providerVersion,allowedTags:[],teeAttestation:{appSecret:this.cfg.appSecret}});
      if(!checked.isVerified||checked.isTeeAttestationVerified!==true||checked.data.length!==1)return fail();
      const {context,extractedParameters:p}=checked.data[0]!;
      if(context.reclaimSessionId!==session.id||context.contextAddress!==session.nonce||context.contextMessage!==session.message)return fail();
      // Only SDK-verified extraction is used. publicData/extractedParameterValues are untrusted.
      // The reviewed provider MUST attest a complete YTD aggregate and the authenticated account.
      if(p.accountId!==session.accountId||p.coversUntil!==String(session.coversUntil)||p.yearStart!==String(Date.UTC(parsePeriod(session.periodId).year,0,1)/1000)||p.complete!=='true'||p.currency!=='USD'||!/^\d{1,30}$/.test(p.grossIncomeCents??''))return fail();
      const timestamp=envelope.proofs[0]!.claimData.timestampS;
      if(!Number.isInteger(timestamp)||timestamp<session.createdAt-60||timestamp>this.now()+60||!/^0x[0-9a-fA-F]{64}$/.test(String(context.providerHash)))return fail();
      if(!await this.cfg.store.consume(session.id))return fail();
      return {ok:true,source:'stripe',figure:BigInt(p.grossIncomeCents!)*10000n,figureHash:null,currency:'USD',coversUntil:session.coversUntil,sessionId:session.id,providerHash:String(context.providerHash)};
    } catch {return fail();}
  }
}

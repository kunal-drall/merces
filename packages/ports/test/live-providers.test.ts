import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {StripeClient,StripeIdentityCheck,readStripeGrossCharges} from '../src/stripe.ts';
import {ReclaimZkTls,type ReclaimConfig,type ReclaimSdk,type ReclaimSession} from '../src/reclaim.ts';
import {DocusignESign} from '../src/docusign.ts';
import {executeProviderJob,localProviderPorts} from '../src/local-providers.ts';
import {parsePeriod} from '@merces/math';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const stripe=(fetcher:typeof fetch)=>new StripeClient({secretKey:'sk_test_disposable',accountId:'acct_test',testMode:true,fetcher});

describe('Stripe provider boundaries',()=>{
  it('uses idempotency, requires the pinned account and passes only verified identity',async()=>{
    const fetcher=vi.fn(async(url:any,init:any)=>String(url).endsWith('/account')?json({id:'acct_test'}):json({id:'vs_test',object:'identity.verification_session',livemode:false,type:'document',status:'verified',url:'https://verify.stripe.com/start/test'}));
    const identity=new StripeIdentityCheck(stripe(fetcher),'https://merces-app.vercel.app/onboarding');
    const result=await identity.start({applicationId:'app_1',accountId:'account_1',kind:'issuer',country:'US'});
    expect(result.checkId).toBe('vs_test');expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toMatch(/^merces-identity-/);
    expect(await identity.status('vs_test')).toBe('passed');
    await expect(identity.start({applicationId:null,accountId:'account_1',kind:'attestor',country:null})).rejects.toThrow('deduplication');
  });
  it.each(['processing','requires_input'])('does not auto-pass %s',async status=>{
    const identity=new StripeIdentityCheck(stripe(async()=>json({id:'vs_test',object:'identity.verification_session',livemode:false,type:'document',status})),'https://merces-app.vercel.app');
    expect(await identity.status('vs_test')).toBe('pending');
  });
  it('rejects live-mode results, redaction and vendor errors without leaking bodies',async()=>{
    const identity=new StripeIdentityCheck(stripe(async()=>json({id:'vs_test',object:'identity.verification_session',livemode:true,type:'document',status:'verified'})),'https://merces-app.vercel.app');
    await expect(identity.status('vs_test')).rejects.toThrow('mode-mismatch');
    await expect(stripe(async()=>json({error:'secret provider payload'},403)).checkAccount()).rejects.toThrow(/^provider-http-403$/);
    await expect(stripe(async()=>json({id:'acct_wrong'})).checkAccount()).rejects.toThrow('account-mismatch');
  });
  it('paginates gross charges and refuses duplicate or mixed-currency data',async()=>{
    const created=Date.UTC(2026,0,10)/1000;
    const row=(id:number)=>({id:'txn_'+id,object:'balance_transaction',type:'charge',amount:100,created,currency:'usd'});
    let page=0;
    const client=stripe(async(url)=>String(url).endsWith('/account')?json({id:'acct_test'}):json({object:'list',url:'/v1/balance_transactions',has_more:page===0,data:page++===0?Array.from({length:100},(_,i)=>row(i)):[row(100)]}));
    expect(await readStripeGrossCharges(client,{year:2026,coversUntil:created,currency:'USD'})).toMatchObject({grossCents:10100n,count:101,complete:true,zkTlsVerified:false});
    for(const data of [[row(1),row(1)],[{...row(1),currency:'eur'}]])await expect(readStripeGrossCharges(stripe(async url=>String(url).endsWith('/account')?json({id:'acct_test'}):json({object:'list',url:'/v1/balance_transactions',has_more:false,data})),{year:2026,coversUntil:created,currency:'USD'})).rejects.toThrow('transaction-invalid');
  });
});

function reclaimHarness(){
  const sessions=new Map<string,ReclaimSession>(),spent=new Set<string>();
  const cfg:ReclaimConfig={appId:'0x'+'1'.repeat(40),appSecret:'0x'+'2'.repeat(64),providerId:'11111111-1111-1111-1111-111111111111',providerVersion:'1.0.0',seriesAccounts:{'monad:1':'acct_test'},store:{put:async s=>{sessions.set(s.id,s);},get:async id=>sessions.get(id)??null,consume:async id=>{if(spent.has(id))return false;spent.add(id);return true;}}};
  let context:Record<string,unknown>={};
  const values={accountId:'acct_test',yearStart:String(Date.UTC(2026,0,1)/1000),coversUntil:String(parsePeriod('2026Q3').end),complete:'true',currency:'USD',grossIncomeCents:'35000'};
  const verify=vi.fn(async()=>({isVerified:true,isTeeAttestationVerified:true,error:undefined,data:[{context,extractedParameters:values}],publicData:[]}));
  const sdk={init:async()=>({setContext:(address:string,message:string)=>{context={contextAddress:address,contextMessage:message,reclaimSessionId:'session_1',providerHash:'0x'+'3'.repeat(64)};},setParams:()=>{},getProviderVersion:()=>({providerId:cfg.providerId,providerVersion:cfg.providerVersion}),getSessionId:()=> 'session_1',getRequestUrl:async()=> 'https://portal.reclaimprotocol.org/test',getStatusUrl:()=> 'https://api.reclaimprotocol.org/status'}),verify} as unknown as ReclaimSdk;
  const now=Math.floor(Date.UTC(2026,9,13)/1000),adapter=new ReclaimZkTls(cfg,sdk,()=>now);
  const input={sessionId:'session_1',proofs:[{claimData:{timestampS:now}}],extractedParameterValues:{grossIncomeCents:'9999999999'}} as any;
  return {cfg,adapter,input,verify,values,sessions,start:()=>adapter.createSession({source:'stripe',seriesId:'monad:1',periodId:'2026Q3',year:2026,coversUntil:parsePeriod('2026Q3').end})};
}
describe('Reclaim proof acceptance',()=>{
  it('uses SDK-trusted extraction, exact version, TEE and one-time durable sessions',async()=>{
    const h=reclaimHarness();await h.start();
    expect(await h.adapter.verify(h.input,{seriesId:'monad:1',periodId:'2026Q3'})).toMatchObject({ok:true,figure:350000000n});
    expect(h.verify.mock.calls[0]).toEqual([h.input.proofs,expect.objectContaining({providerVersion:'1.0.0',teeAttestation:{appSecret:h.cfg.appSecret}})]);
    expect((await h.adapter.verify(h.input,{seriesId:'monad:1',periodId:'2026Q3'})).ok).toBe(false);
  });
  it.each(['complete','accountId','currency','coversUntil','yearStart','grossIncomeCents'])('refuses invalid verified %s',async field=>{
    const h=reclaimHarness();await h.start();(h.values as Record<string,string>)[field]='invalid';
    expect((await h.adapter.verify(h.input,{seriesId:'monad:1',periodId:'2026Q3'})).ok).toBe(false);
  });
  it('rejects wrong chain/period, missing TEE and last-transaction provider',async()=>{
    const h=reclaimHarness();await h.start();
    expect((await h.adapter.verify(h.input,{seriesId:'solana:other',periodId:'2026Q3'})).ok).toBe(false);
    h.verify.mockResolvedValueOnce({isVerified:true,isTeeAttestationVerified:false,error:undefined,data:[],publicData:[]});
    expect((await h.adapter.verify(h.input,{seriesId:'monad:1',periodId:'2026Q3'})).ok).toBe(false);
    expect(()=>new ReclaimZkTls({...h.cfg,providerId:'acfdeaa9-9250-4acd-afd3-fac7ca03458b'})).toThrow('reviewed-provider');
  });
});

describe('DocuSign completion',()=>{
  const id='11111111-1111-1111-1111-111111111111';
  const privateKeyPem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const config={accountId:id,integrationKey:id,userId:id,privateKeyPem,returnUrl:'https://merces-app.vercel.app/issuer',signers:{acct_1:{name:'Synthetic Tester',email:'tester@example.invalid'}}};
  it('does not equate recipient signed with completed, or an unknown state with success',async()=>{
    let status='signed';const port=new DocusignESign({...config,fetcher:async url=>String(url).includes('/oauth/token')?json({access_token:'test-token',expires_in:3600}):json({envelopeId:id,status})});
    expect(await port.status(id)).toBe('sent');expect(await port.signedDocument(id)).toBeNull();
    status='unexpected';await expect(port.status(id)).rejects.toThrow('status-unknown');
  });
  it('escapes documents, uses embedded recipients, and recovers the same transaction after retries',async()=>{
    let created=false;const calls:any[]=[];
    const port=new DocusignESign({...config,fetcher:async(url,init)=>{
      const path=String(url);calls.push({path,body:init?.body});
      if(path.includes('/oauth/token'))return json({access_token:'test-token',expires_in:3600});
      if(path.includes('?transaction_ids='))return json({envelopes:created?[{envelopeId:id}]:[]});
      if(path.endsWith('/recipients'))return json({signers:[{...config.signers.acct_1,clientUserId:'acct_1',recipientId:'1'}]});
      if(path.endsWith('/views/recipient'))return json({url:'https://demo.docusign.net/signing/test'});
      created=true;return json({envelopeId:id});
    }});
    const input={sessionId:'session_1',signerAccountId:'acct_1',documents:[{name:'Test',body:'<script>bad</script>'}]};
    await port.createEnvelope(input);await port.createEnvelope(input);
    const creations=calls.filter(c=>c.path.endsWith('/envelopes'));expect(creations).toHaveLength(1);
    const body=JSON.parse(creations[0].body);expect(Buffer.from(body.documents[0].documentBase64,'base64').toString()).toContain('&lt;script&gt;');
    expect(body.recipients.signers[0].clientUserId).toBe('acct_1');
  });
  it('local provider RPC rejects unconfigured providers and invalid completion values',async()=>{
    await expect(executeProviderJob({operation:'identity.status',id:'vs_test'},{})).rejects.toThrow('not-configured');
    const ports=localProviderPorts(async()=> 'automatic-pass');await expect(ports.identity.status('vs_test')).rejects.toThrow();
    await expect(ports.reclaim.verify({} as any,{seriesId:'monad:1',periodId:'2026Q3'})).rejects.toThrow('encrypted-local-verifier');
  });
});

import { z } from 'zod';
import type { IdentityCheckPort } from './identity.ts';
import type { ESignPort } from './esign.ts';
import type { ZkTlsPort } from './zktls.ts';

export const providerJobSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('identity.start'),params:z.object({applicationId:z.string().max(160).nullable(),accountId:z.string().max(160),kind:z.enum(['issuer','backer','attestor']),country:z.string().length(2).nullable()}).strict()}).strict(),
  z.object({operation:z.literal('identity.status'),id:z.string().max(160)}).strict(),
  z.object({operation:z.literal('esign.create'),params:z.object({sessionId:z.string().max(160),signerAccountId:z.string().max(160),documents:z.array(z.object({name:z.string().max(200),body:z.string().max(100000)}).strict()).min(1).max(8)}).strict()}).strict(),
  z.object({operation:z.enum(['esign.status','esign.url','esign.document']),id:z.string().max(160)}).strict(),
  z.object({operation:z.literal('reclaim.create'),params:z.object({source:z.enum(['stripe','deel','distrokid']),seriesId:z.string().max(160),periodId:z.string().regex(/^\d{4}Q[1-4]$/),coversUntil:z.number().int(),year:z.number().int()}).strict()}).strict(),
]);
export type ProviderJob=z.infer<typeof providerJobSchema>;
export async function executeProviderJob(input:unknown,providers:{identity?:IdentityCheckPort;esign?:ESignPort;reclaim?:ZkTlsPort}):Promise<unknown> {
  const job=providerJobSchema.parse(input);
  switch(job.operation){
    case 'identity.start': if(providers.identity)return providers.identity.start(job.params);break;
    case 'identity.status': if(providers.identity)return providers.identity.status(job.id);break;
    case 'esign.create': if(providers.esign)return providers.esign.createEnvelope(job.params);break;
    case 'esign.status': if(providers.esign)return providers.esign.status(job.id);break;
    case 'esign.url': if(providers.esign?.signingUrl)return providers.esign.signingUrl(job.id);break;
    case 'esign.document': if(providers.esign)return providers.esign.signedDocument(job.id);break;
    case 'reclaim.create': if(providers.reclaim)return providers.reclaim.createSession(job.params);break;
  }
  throw Error('local-provider-not-configured');
}

/** Narrow RPC ports: the hosted server receives results, never vendor credentials. */
export function localProviderPorts(call:(job:ProviderJob)=>Promise<unknown>) {
  const text=z.string();
  const identity:IdentityCheckPort={provider:'stripe-identity',
    start:async params=>z.object({checkId:text,redirectUrl:text.url()}).parse(await call({operation:'identity.start',params})),
    status:async id=>z.enum(['pending','passed','failed']).parse(await call({operation:'identity.status',id}))};
  const esign:ESignPort={provider:'docusign-demo',
    createEnvelope:async params=>z.object({envelopeId:text,signingUrl:text.url()}).parse(await call({operation:'esign.create',params})),
    status:async id=>z.enum(['sent','signed','declined','expired']).parse(await call({operation:'esign.status',id})),
    signingUrl:async id=>text.url().parse(await call({operation:'esign.url',id})),
    signedDocument:async id=>z.object({body:text,completedAt:text}).nullable().parse(await call({operation:'esign.document',id}))};
  const reclaim:ZkTlsPort={provider:'reclaim',
    createSession:async params=>z.object({sessionId:text,requestUrl:text.url(),statusUrl:text.url()}).parse(await call({operation:'reclaim.create',params})),
    verify:async()=>{throw Error('income-proof-must-use-encrypted-local-verifier');}};
  return {identity,esign,reclaim};
}

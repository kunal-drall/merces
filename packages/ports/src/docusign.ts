import { createHash, createSign } from 'node:crypto';
import type { ESignPort } from './esign.ts';
import { providerJson, providerRequest } from './provider-http.ts';

export interface DocusignConfig {
  accountId:string; integrationKey:string; userId:string; privateKeyPem:string; returnUrl:string;
  /** Explicit per-account signer mapping. Never fabricate email addresses from wallet IDs. */
  signers:Record<string,{name:string;email:string}>;
  fetcher?:typeof fetch;
}
const guid=/^[0-9a-f-]{36}$/i;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** Real DocuSign developer API, embedded signing (no email send). JWT/RSA key stays on the local worker. */
export class DocusignESign implements ESignPort {
  readonly provider='docusign-demo';
  private token?:{value:string;expiresAt:number};
  constructor(private cfg:DocusignConfig) {
    if(![cfg.accountId,cfg.integrationKey,cfg.userId].every(v=>guid.test(v))||new URL(cfg.returnUrl).protocol!=='https:')throw Error('docusign-configuration-invalid');
  }
  private async accessToken() {
    if(this.token&&this.token.expiresAt>Date.now()+60000)return this.token.value;
    const now=Math.floor(Date.now()/1000),part=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const unsigned=part({alg:'RS256',typ:'JWT'})+'.'+part({iss:this.cfg.integrationKey,sub:this.cfg.userId,aud:'account-d.docusign.com',iat:now,exp:now+3600,scope:'signature impersonation'});
    let signature:string;try{signature=createSign('RSA-SHA256').update(unsigned).sign(this.cfg.privateKeyPem,'base64url');}catch{throw Error('docusign-local-key-invalid');}
    const result=await providerJson('https://account-d.docusign.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature})},this.cfg.fetcher);
    if(typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error('docusign-token-invalid');
    this.token={value:result.access_token,expiresAt:Date.now()+Math.min(result.expires_in,3600)*1000};
    return this.token.value;
  }
  private async request(path:string,body?:unknown) {
    return providerJson(`https://demo.docusign.net/restapi/v2.1/accounts/${this.cfg.accountId}${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+await this.accessToken(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},this.cfg.fetcher);
  }
  async checkAccount():Promise<void> {
    const info=await providerJson('https://account-d.docusign.com/oauth/userinfo',{headers:{Authorization:'Bearer '+await this.accessToken()}},this.cfg.fetcher);
    if(info.sub!==this.cfg.userId||!Array.isArray(info.accounts)||!info.accounts.some(a=>a.account_id===this.cfg.accountId&&a.base_uri==='https://demo.docusign.net'))throw Error('docusign-account-mismatch');
  }
  async createEnvelope(params:Parameters<ESignPort['createEnvelope']>[0]) {
    const signer=this.cfg.signers[params.signerAccountId];
    if(!signer||!signer.name.trim()||!/^\S+@\S+\.\S+$/.test(signer.email))throw Error('docusign-signer-not-configured');
    if(!params.documents.length||params.documents.length>8||params.documents.some(d=>d.body.length>100000))throw Error('docusign-document-invalid');
    const transactionId=createHash('sha256').update(params.sessionId).digest('hex').slice(0,32);
    // Recover by transaction ID first: retries after a connection failure must not create a second envelope.
    const prior=await this.request('/envelopes?transaction_ids='+transactionId);
    let envelopeId=prior.envelopes?.[0]?.envelopeId;
    if(!envelopeId){
      const result=await this.request('/envelopes',{
        transactionId,status:'sent',emailSubject:'Merces test-network agreement',
        customFields:{textCustomFields:[{name:'merces_session',value:params.sessionId,show:'false'},{name:'merces_account',value:params.signerAccountId,show:'false'}]},
        documents:params.documents.map((doc,index)=>({documentId:String(index+1),name:doc.name,fileExtension:'html',documentBase64:Buffer.from(`<html><body><h2>TEST ONLY — no real financial obligation</h2><h1>${escape(doc.name)}</h1><pre style="white-space:pre-wrap">${escape(doc.body)}</pre><p>Merces test signature /merces-sign-${index+1}/</p></body></html>`).toString('base64')})),
        recipients:{signers:[{name:signer.name,email:signer.email,recipientId:'1',clientUserId:params.signerAccountId,routingOrder:'1',tabs:{signHereTabs:params.documents.map((_,i)=>({anchorString:`/merces-sign-${i+1}/`,anchorUnits:'pixels',anchorXOffset:'0',anchorYOffset:'0',anchorIgnoreIfNotPresent:'false'}))}}]},
      });
      envelopeId=result.envelopeId;
    }
    if(typeof envelopeId!=='string'||!guid.test(envelopeId))throw Error('docusign-envelope-invalid');
    return {envelopeId,signingUrl:await this.signingUrl(envelopeId)};
  }
  async signingUrl(envelopeId:string):Promise<string> {
    if(!guid.test(envelopeId))throw Error('docusign-envelope-invalid');
    const recipients=await this.request(`/envelopes/${envelopeId}/recipients`),signer=recipients.signers?.[0];
    if(recipients.signers?.length!==1||!signer?.clientUserId)throw Error('docusign-signer-invalid');
    const expected=this.cfg.signers[signer.clientUserId];
    if(!expected||expected.email!==signer.email||expected.name!==signer.name)throw Error('docusign-signer-mismatch');
    const view=await this.request(`/envelopes/${envelopeId}/views/recipient`,{returnUrl:this.cfg.returnUrl,authenticationMethod:'none',clientUserId:signer.clientUserId,userName:signer.name,email:signer.email,recipientId:signer.recipientId});
    if(typeof view.url!=='string'||new URL(view.url).origin!=='https://demo.docusign.net')throw Error('docusign-signing-url-invalid');
    return view.url;
  }
  async status(envelopeId:string):Promise<'sent'|'signed'|'declined'|'expired'> {
    if(!guid.test(envelopeId))throw Error('docusign-envelope-invalid');
    const e=await this.request('/envelopes/'+envelopeId);
    if(e.envelopeId!==envelopeId)throw Error('docusign-envelope-mismatch');
    if(e.status==='completed')return 'signed';
    if(e.status==='declined')return 'declined';
    if(e.status==='voided')return 'expired';
    if(['created','sent','delivered','signed'].includes(e.status))return 'sent'; // recipient signing alone is not envelope completion
    throw Error('docusign-status-unknown');
  }
  async signedDocument(envelopeId:string) {
    if(await this.status(envelopeId)!=='signed')return null;
    const envelope=await this.request('/envelopes/'+envelopeId);
    if(!Number.isFinite(Date.parse(envelope.completedDateTime)))throw Error('docusign-completion-invalid');
    const response=await providerRequest(`https://demo.docusign.net/restapi/v2.1/accounts/${this.cfg.accountId}/envelopes/${envelopeId}/documents/combined?certificate=true`,{headers:{Authorization:'Bearer '+await this.accessToken()}},this.cfg.fetcher);
    if(!response.headers.get('content-type')?.includes('application/pdf')||Number(response.headers.get('content-length')??0)>500_000)throw Error('docusign-document-invalid');
    const reader=response.body?.getReader();
    if(!reader)throw Error('docusign-document-invalid');
    const chunks:Uint8Array[]=[];let size=0;
    try {
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>500_000)throw Error('docusign-document-invalid');chunks.push(value);}
    } finally {await reader.cancel();}
    const bytes=Buffer.concat(chunks);
    if(bytes.length>500_000||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('docusign-document-invalid');
    return {body:JSON.stringify({format:'docusign-signed-pdf-v1',envelopeId,sha256:createHash('sha256').update(bytes).digest('hex'),pdfBase64:bytes.toString('base64')}),completedAt:envelope.completedDateTime as string};
  }
}

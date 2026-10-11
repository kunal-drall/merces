import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTransaction, type Pool } from '@merces/db';
import type { FormsConfig } from './config.ts';
import { hash } from './service.ts';
/** Claims a durable lease before I/O; a crash cannot reset the provider's idempotency window. */
export async function deliverFormMail(pool: Pool, config: FormsConfig, send: typeof fetch = fetch): Promise<boolean> {
  const row=await withTransaction(pool,async db=>{
    const r=(await db.query("select m.*,e.email_hash from public_form_mail m join public_form_entries e on e.id=m.entry_id where m.status='pending' and m.next_attempt_at<=now() order by m.next_attempt_at for update of m skip locked limit 1")).rows[0];
    if(!r)return null;
    if((await db.query('select 1 from public_form_suppressions where email_hash=$1',[r.email_hash])).rowCount){await db.query("update public_form_mail set status='suppressed' where entry_id=$1",[r.entry_id]);return null;}
    // Never reuse a key after Resend's 24h retention. Ambiguous old requests require provider reconciliation.
    if(r.first_attempt_at&&Date.now()-new Date(r.first_attempt_at).getTime()>=23*3600_000){await db.query("update public_form_mail set status='uncertain',last_error='idempotency-window-ended' where entry_id=$1",[r.entry_id]);return null;}
    await db.query("update public_form_mail set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),next_attempt_at=now()+interval '2 minutes' where entry_id=$1",[r.entry_id]);
    return {...r,attempts:Number(r.attempts)+1};
  });
  if(!row)return false;
  let status='pending',code='transport',providerId:string|null=null,retryAfter=0;
  try {
    const message=config.vault.decrypt(row.ciphertext,'mail:'+row.entry_id);
    const response=await send('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':'merces-form/'+row.entry_id},body:message,signal:AbortSignal.timeout(10_000),redirect:'error'});
    const result=await response.json().catch(()=>null) as {id?:unknown;name?:unknown}|null;
    if(response.ok&&typeof result?.id==='string'&&result.id.length<=100){providerId=result.id;status='sent';code='';}
    else { code='provider-'+response.status;const retryable=response.status===429||response.status>=500||(response.status===409&&result?.name==='concurrent_idempotent_requests');status=retryable?'pending':response.ok?'uncertain':'failed';const seconds=Number(response.headers.get('retry-after'));if(Number.isFinite(seconds)&&seconds>0)retryAfter=Math.min(seconds,3600); }
  } catch { /* Body, provider errors and addresses never reach logs or last_error. */ }
  if(status==='pending'&&row.attempts>=8)status='uncertain';
  const delay=Math.max(retryAfter,Math.min(1800,5*2**row.attempts));
  await pool.query("update public_form_mail set status=coalesce((select state from public_form_delivery_events where provider_id=$2),$3),provider_id=$2,last_error=$4,next_attempt_at=now()+$5*interval '1 second' where entry_id=$1 and status='pending'",[row.entry_id,providerId,status,code||null,delay]);
  return true;
}
/** Svix signed content: message id + timestamp + exact raw bytes; accepts rotation signatures, 5m clock tolerance. */
export function verifyWebhook(config: FormsConfig, raw: string, headers: Record<string,unknown>, now=Date.now()): string {
  const id=headers['svix-id'],ts=headers['svix-timestamp'],signatures=headers['svix-signature'];
  if(typeof id!=='string'||id.length>200||typeof ts!=='string'||!/^\d{10}$/.test(ts)||typeof signatures!=='string'||signatures.length>2000||Math.abs(now/1000-Number(ts))>300)throw Error('invalid webhook');
  const expected=createHmac('sha256',Buffer.from(config.webhookSecret.slice(6),'base64')).update(`${id}.${ts}.${raw}`).digest();
  if(!signatures.split(' ').some(s=>{const [v,value]=s.split(',');if(v!=='v1'||!value)return false;const actual=Buffer.from(value,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);}))throw Error('invalid webhook');
  return id;
}
export async function receiveWebhook(pool: Pool,config: FormsConfig,raw: string,headers: Record<string,unknown>) {
  const id=verifyWebhook(config,raw,headers);
  const event=JSON.parse(raw) as {type?:string;data?:{email_id?:string;to?:unknown}};
  const state=({'email.delivered':'delivered','email.bounced':'bounced','email.complained':'complained'} as Record<string,string>)[event.type??''];
  await withTransaction(pool,async db=>{
    if(!(await db.query('insert into public_form_webhooks(event_id) values($1) on conflict do nothing returning event_id',[id])).rowCount)return;
    if(!state||typeof event.data?.email_id!=='string'||event.data.email_id.length>100)return;
    const providerId=event.data.email_id;
    // Negative outcomes dominate delivered events even when provider callbacks arrive out of order.
    await db.query("insert into public_form_delivery_events(provider_id,state) values($1,$2) on conflict(provider_id) do update set state=case when public_form_delivery_events.state in ('bounced','complained') then public_form_delivery_events.state else excluded.state end",[providerId,state]);
    await db.query("update public_form_mail set status=(select state from public_form_delivery_events where provider_id=$1) where provider_id=$1",[providerId]);
    if(state==='bounced'||state==='complained'){
      const recipients=Array.isArray(event.data.to)?event.data.to.filter((v):v is string=>typeof v==='string'&&v.length<=254).slice(0,50):[];
      for(const email of recipients){const h=hash(config,'email:'+email.trim().toLowerCase());await db.query('insert into public_form_suppressions(email_hash,reason) select distinct email_hash,$2 from public_form_entries where email_hash=$1 on conflict do nothing',[h,state]);}
      await db.query("insert into public_form_suppressions(email_hash,reason) select e.email_hash,$2 from public_form_entries e join public_form_mail m on m.entry_id=e.id where m.provider_id=$1 on conflict do nothing",[providerId,state]);
    }
  });
}
export async function pruneForms(pool: Pool){await pool.query('delete from public_form_entries where expires_at<now()');await pool.query("delete from public_form_webhooks where received_at<now()-interval '30 days'");await pool.query("delete from public_form_delivery_events where received_at<now()-interval '30 days'");}

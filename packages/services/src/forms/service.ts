import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '@merces/core';
import { withTransaction, type Pool } from '@merces/db';
import type { FormsConfig } from './config.ts';
import { parseSubmission, type FormId } from './schema.ts';
export function hash(config: FormsConfig, value: string): string { return createHmac('sha256',config.hashSecret).update(value).digest('hex'); }
export function authorized(config: FormsConfig, token: unknown): boolean { const a=Buffer.from(config.token),b=Buffer.from(typeof token==='string'?token:''); return a.length===b.length&&timingSafeEqual(a,b); }
function canonical(v: unknown): string { if(!v||typeof v!=='object')return JSON.stringify(v); if(Array.isArray(v))return JSON.stringify(v);return '{'+Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'; }
export async function submitForm(pool: Pool, config: FormsConfig, form: FormId, raw: unknown) {
  let body: ReturnType<typeof parseSubmission>;
  try { body=parseSubmission(form,raw); } catch { throw AppError.badRequest('invalid form fields or consent'); }
  // Receipt timestamps are server-owned; exclude gateway consent timestamp from retry equality.
  const requestHash=hash(config,canonical({form,fields:body.fields,consentVersion:body.consent?.version}));
  const emailHash=hash(config,'email:'+body.fields.email);
  return withTransaction(pool,async db=>{
    // Serialize quota and idempotency checks across gateway instances. No PII in locks or errors.
    await db.query("select pg_advisory_xact_lock(1835364963, 39)");
    const prior=(await db.query('select request_hash from public_form_entries where form=$1 and submission_key=$2',[form,body.key])).rows[0];
    if(prior){if(prior.request_hash!==requestHash)throw AppError.conflict('submission key already used');return {ok:true,duplicate:true};}
    const counts=(await db.query("select count(*) filter(where email_hash=$1 and received_at>now()-interval '1 day') as recipient, count(*) filter(where received_at>now()-interval '1 hour') as total from public_form_entries where received_at>now()-interval '1 day'",[emailHash])).rows[0];
    if(Number(counts.recipient)>=3||Number(counts.total)>=1000)throw new AppError(429,'RateLimited','please retry later');
    const id=randomUUID();
    const entry={form,fields:body.fields,...(body.consent?{consent:{version:body.consent.version,at:new Date().toISOString()}}:{})};
    await db.query("insert into public_form_entries(id,form,submission_key,request_hash,email_hash,ciphertext,expires_at) values($1,$2,$3,$4,$5,$6,now()+$7*interval '1 day')",[id,form,body.key,requestHash,emailHash,config.vault.encrypt(JSON.stringify(entry),'form:'+id),config.retentionDays]);
    const suppressed=Boolean((await db.query('select 1 from public_form_suppressions where email_hash=$1',[emailHash])).rowCount);
    // Immutable request snapshot: a retry uses identical provider payload and idempotency key.
    const message={from:config.from,to:[body.fields.email],reply_to:'ohayo@merces.fi',subject:'Merces received your request',text:'We received your '+({waitlist:'waitlist request','issuer-invite':'issuer invite request','backer-application':'backer waitlist request','humanathon-notify':'Humanathon notification request','humanathon-partner':'Humanathon partner enquiry'}[form])+'.\n\nThis confirms receipt only. It is not an application approval, event entry or allocation. No launch date is confirmed.\n\nTo correct or delete your request, reply to ohayo@merces.fi. If you did not submit it, no action is required. We will not send a deck or add you to unrelated mailing lists.'};
    await db.query('insert into public_form_mail(entry_id,ciphertext,status) values($1,$2,$3)',[id,config.vault.encrypt(JSON.stringify(message),'mail:'+id),suppressed?'suppressed':'pending']);
    return {ok:true,duplicate:false};
  });
}
/** For an operator fulfilling a verified deletion request. No lookup results leave this function. */
export async function eraseForms(pool: Pool, config: FormsConfig, email: string) { const h=hash(config,'email:'+email.trim().toLowerCase()); await withTransaction(pool,async db=>{await db.query("select pg_advisory_xact_lock(1835364963, 39)");await db.query("insert into public_form_suppressions(email_hash,reason) values($1,'requested') on conflict(email_hash) do update set reason='requested'",[h]);await db.query('delete from public_form_entries where email_hash=$1',[h]);}); }

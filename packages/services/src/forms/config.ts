import { AesGcmVault } from '@merces/ports';
export interface FormsConfig { token: string; hashSecret: string; vault: AesGcmVault; apiKey: string; from: string; webhookSecret: string; retentionDays: number; }
/** Independent secrets, no development defaults. Values are never included in errors. */
export function formsConfig(env: NodeJS.ProcessEnv = process.env): FormsConfig | null {
  if (env.MERCES_FORMS_ENABLED !== 'true' || env.MERCES_FORMS_PRIVACY_APPROVED !== 'true') return null;
  const token=env.MERCES_FORMS_TOKEN??'', hashSecret=env.MERCES_FORMS_HASH_SECRET??'', key=env.MERCES_FORMS_KEY_HEX??'', apiKey=env.RESEND_API_KEY??'', from=env.MERCES_FORMS_FROM??'', webhookSecret=env.RESEND_WEBHOOK_SECRET??'';
  const retentionDays=Number(env.MERCES_FORMS_RETENTION_DAYS??30);
  if(token.length<32||hashSecret.length<32||!/^[a-f0-9]{64}$/i.test(key)||!apiKey||!/^Merces <[a-z0-9._+-]+@(?:mail\.)?merces\.fi>$/.test(from)||!/^whsec_[A-Za-z0-9+/=]+$/.test(webhookSecret)||!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>90) return null;
  return {token,hashSecret,vault:new AesGcmVault('forms-1',key),apiKey,from,webhookSecret,retentionDays};
}

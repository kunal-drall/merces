import { z } from 'zod';
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const email = text(254).pipe(z.email()).transform(x => x.toLowerCase());
const link = z.string().max(300).refine(x => { try { const u = new URL(x); return ['https:', 'http:'].includes(u.protocol) && /^[^.]+(\.[^.]+)+$/.test(u.hostname) && !u.username && !u.password; } catch { return false; } }).optional();
export const formIds = ['waitlist', 'issuer-invite', 'backer-application', 'humanathon-notify', 'humanathon-partner'] as const;
export type FormId = typeof formIds[number];
export const fields = {
  waitlist: z.object({ role: z.enum(['raising','backing','both']), email }).strict(),
  'issuer-invite': z.object({ what: text(240), email }).strict(),
  'backer-application': z.object({ country: text(80), email, list: z.literal('waitlist'), role: z.literal('backing') }).strict(),
  'humanathon-notify': z.object({ name: text(120), email, country: text(80), track: z.enum(['builders','artists','independents','other']), link, prove: optionalText(2000) }).strict(),
  'humanathon-partner': z.object({ organisation: text(120), name: text(120), role: optionalText(120), email, handle: optionalText(120), tier: z.enum(['lead','track','payments','infrastructure','accelerator','anchor','community']), message: optionalText(2000) }).strict(),
};
export const submissionSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  fields: z.record(z.string(), z.unknown()),
  consent: z.object({ version: z.literal('humanathon-consent-v1'), at: z.iso.datetime() }).strict().optional(),
}).strict();
export function parseSubmission(form: FormId, raw: unknown) {
  const body = submissionSchema.parse(raw);
  const validated = fields[form].parse(body.fields);
  if (form.startsWith('humanathon-') !== Boolean(body.consent)) throw new Error('consent');
  return { ...body, fields: validated };
}

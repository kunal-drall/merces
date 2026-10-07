import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens: base64url(JSON payload).base64url(HMAC-SHA256). Issued after wallet sign-in (E2).
 * They carry the account's roles and wallets so the access tier can be resolved per request.
 */
export type Role = 'issuer' | 'backer' | 'attestor' | 'admin';

export interface Session {
  accountId: string;
  wallets: { chain: string; address: string }[];
  roles: Role[];
  /** passed eligibility review (backer or issuer) */
  eligible: boolean;
  /** unix seconds */
  exp: number;
  iat: number;
}

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

export function issueSession(secret: string, s: Omit<Session, 'iat'>): string {
  const payload = b64(JSON.stringify({ ...s, iat: Math.floor(Date.now() / 1000) }));
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, token: string, now: number = Math.floor(Date.now() / 1000)): Session | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    if (typeof s.exp !== 'number' || s.exp < now) return null;
    return s;
  } catch {
    return null;
  }
}

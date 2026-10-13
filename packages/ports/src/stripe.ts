import { createHash } from 'node:crypto';
import type { IdentityCheckPort, IdentityCheckKind, IdentityCheckStatus } from './identity.ts';
import { providerJson } from './provider-http.ts';

export interface StripeConfig { secretKey: string; accountId: string; testMode: boolean; fetcher?: typeof fetch }

/** Uses the authenticated account API and refuses a mismatched account or key mode. */
export class StripeClient {
  constructor(readonly config: StripeConfig) {
    if (!new RegExp(`^(sk|rk)_${config.testMode ? 'test' : 'live'}_[A-Za-z0-9]+$`).test(config.secretKey) || !/^acct_[A-Za-z0-9]+$/.test(config.accountId)) throw Error('stripe-configuration-invalid');
  }
  async request(path: string, body?: URLSearchParams, idempotencyKey?: string) {
    if (!path.startsWith('/v1/')) throw Error('stripe-path-refused');
    return providerJson('https://api.stripe.com' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + this.config.secretKey,
        ...(body ? {'Content-Type':'application/x-www-form-urlencoded'} : {}), ...(idempotencyKey ? {'Idempotency-Key':idempotencyKey} : {}) }, body,
    }, this.config.fetcher);
  }
  async checkAccount() { const account = await this.request('/v1/account'); if (account.id !== this.config.accountId) throw Error('stripe-account-mismatch'); }
}

/** Hosted Stripe Identity: only session ID/status are retained by Merces. No ID images/outputs are requested. */
export class StripeIdentityCheck implements IdentityCheckPort {
  readonly provider = 'stripe-identity';
  constructor(private client: StripeClient, private returnUrl: string) {
    if (new URL(returnUrl).protocol !== 'https:') throw Error('identity-return-url-invalid');
  }
  async start(params: {applicationId: string|null; accountId: string; kind: IdentityCheckKind; country: string|null}) {
    // Stripe sessions are not a stable deduplicated-person reference. Do not pretend they satisfy attestor uniqueness.
    if (params.kind === 'attestor') throw Error('identity-attestor-deduplication-unavailable');
    await this.client.checkAccount();
    const fields = new URLSearchParams({type:'document', return_url:this.returnUrl,
      'metadata[merces_account]':params.accountId, 'metadata[merces_application]':params.applicationId ?? '', 'metadata[merces_kind]':params.kind,
      'options[document][require_matching_selfie]':'true'});
    const key = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const session = await this.client.request('/v1/identity/verification_sessions', fields, 'merces-identity-' + key);
    this.validate(session);
    if (!/^vs_[A-Za-z0-9]+$/.test(session.id) || typeof session.url !== 'string' || new URL(session.url).origin !== 'https://verify.stripe.com') throw Error('identity-session-invalid');
    return {checkId:session.id as string, redirectUrl:session.url as string};
  }
  private validate(session: Record<string,any>) {
    if (session.object !== 'identity.verification_session' || session.livemode !== !this.client.config.testMode || session.type !== 'document') throw Error('identity-mode-mismatch');
  }
  async status(checkId: string): Promise<IdentityCheckStatus> {
    if (!/^vs_[A-Za-z0-9]+$/.test(checkId)) throw Error('identity-session-invalid');
    const session = await this.client.request('/v1/identity/verification_sessions/' + checkId);
    this.validate(session);
    if (session.id !== checkId) throw Error('identity-session-mismatch');
    if (session.redaction) return 'failed';
    if (session.status === 'verified') return 'passed';
    if (session.status === 'canceled') return 'failed';
    if (['requires_input','processing'].includes(session.status)) return 'pending';
    throw Error('identity-status-unknown');
  }
}

/** Real Stripe API diagnostic. This is NOT a zkTLS proof and never authorizes an income attestation. */
export async function readStripeGrossCharges(client: StripeClient, params: {year: number; coversUntil: number; currency: string}) {
  const start = Date.UTC(params.year, 0, 1) / 1000;
  if (!Number.isInteger(params.coversUntil) || params.coversUntil < start || params.coversUntil >= Date.UTC(params.year + 1,0,1)/1000 || params.coversUntil > Date.now()/1000 || !/^[A-Z]{3}$/.test(params.currency)) throw Error('stripe-period-invalid');
  await client.checkAccount();
  let after = '', cents = 0n, count = 0; const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const query = new URLSearchParams({type:'charge',limit:'100','created[gte]':String(start),'created[lte]':String(params.coversUntil)});
    if (after) query.set('starting_after',after);
    const page = await client.request('/v1/balance_transactions?' + query);
    if (page.object !== 'list' || page.url !== '/v1/balance_transactions' || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw Error('stripe-page-invalid');
    for (const row of page.data) {
      if (!/^txn_[A-Za-z0-9]+$/.test(row.id) || seen.has(row.id) || row.object !== 'balance_transaction' || row.type !== 'charge' || !Number.isSafeInteger(row.amount) || row.amount < 0 || !Number.isInteger(row.created) || row.created < start || row.created > params.coversUntil || row.currency !== params.currency.toLowerCase()) throw Error('stripe-transaction-invalid');
      seen.add(row.id); cents += BigInt(row.amount); count++;
    }
    if (!page.has_more) return {accountId:client.config.accountId, currency:params.currency, grossCents:cents, count, complete:true as const, testMode:client.config.testMode, zkTlsVerified:false as const};
    if (page.data.length !== 100) throw Error('stripe-pagination-invalid');
    after = page.data.at(-1).id;
  }
  throw Error('stripe-pagination-limit');
}

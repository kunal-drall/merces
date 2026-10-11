/**
 * Identity-check port (E2). The real provider is an open question (Part J.1); only the mock exists.
 * The backend stores the provider's check id and status: never identity documents or extracted data.
 *
 * Three kinds of check: an issuer's and a backer's belong to an application; an attestor's belongs to the account
 * itself (S4 owner decision, A-SIG-7: "two separately verified accounts, enforced at registration"), so it has no
 * application id. The real provider must also expose a stable reference to the verified person, so that a second
 * account of one person can be refused at attestor registration (the mock cannot tell two accounts apart).
 */
export type IdentityCheckKind = 'issuer' | 'backer' | 'attestor';
export type IdentityCheckStatus = 'pending' | 'passed' | 'failed';

export interface IdentityCheckPort {
  readonly provider: string;
  /** Start a check; returns the provider's check id and a URL the applicant completes it at. */
  start(params: { applicationId: string | null; accountId: string; kind: IdentityCheckKind; country: string | null }): Promise<{ checkId: string; redirectUrl: string }>;
  status(checkId: string): Promise<IdentityCheckStatus>;
}

export class MockIdentityCheck implements IdentityCheckPort {
  readonly provider = 'mock';
  private readonly checks = new Map<string, IdentityCheckStatus>();
  constructor(private readonly behaviour: 'auto-pass' | 'manual' = 'auto-pass') {}
  async start(params: { applicationId: string | null; accountId: string; kind: IdentityCheckKind; country: string | null }): Promise<{ checkId: string; redirectUrl: string }> {
    // an application's check is named by the application; an account's (attestor) by the kind and the account
    const checkId = params.applicationId !== null ? `mockid_${params.applicationId}` : `mockid_${params.kind}_${params.accountId}`;
    this.checks.set(checkId, this.behaviour === 'auto-pass' ? 'passed' : 'pending');
    return { checkId, redirectUrl: `https://identity.mock.invalid/verify/${checkId}` };
  }
  async status(checkId: string): Promise<IdentityCheckStatus> {
    return this.checks.get(checkId) ?? 'pending';
  }
  /** test hook */
  set(checkId: string, s: IdentityCheckStatus): void {
    this.checks.set(checkId, s);
  }
}

/**
 * Identity-check port (E2). The real provider is an open question (Part J.1); only the mock exists.
 * The backend stores the provider's check id and status: never identity documents or extracted data.
 */
export interface IdentityCheckPort {
  readonly provider: string;
  /** Start a check; returns the provider's check id and a URL the applicant completes it at. */
  start(params: { applicationId: string; accountId: string; kind: 'issuer' | 'backer'; country: string | null }): Promise<{ checkId: string; redirectUrl: string }>;
  status(checkId: string): Promise<'pending' | 'passed' | 'failed'>;
}

export class MockIdentityCheck implements IdentityCheckPort {
  readonly provider = 'mock';
  private readonly checks = new Map<string, 'pending' | 'passed' | 'failed'>();
  constructor(private readonly behaviour: 'auto-pass' | 'manual' = 'auto-pass') {}
  async start(params: { applicationId: string; accountId: string; kind: 'issuer' | 'backer'; country: string | null }): Promise<{ checkId: string; redirectUrl: string }> {
    const checkId = `mockid_${params.applicationId}`;
    this.checks.set(checkId, this.behaviour === 'auto-pass' ? 'passed' : 'pending');
    return { checkId, redirectUrl: `https://identity.mock.invalid/verify/${checkId}` };
  }
  async status(checkId: string): Promise<'pending' | 'passed' | 'failed'> {
    return this.checks.get(checkId) ?? 'pending';
  }
  /** test hook */
  set(checkId: string, s: 'pending' | 'passed' | 'failed'): void {
    this.checks.set(checkId, s);
  }
}

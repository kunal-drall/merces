import type { ReportAttestationRecord } from '@merces/domain';
import type { AttestFailure, AttestRequest, AttestResult, ReportVerifierPort, VerifierKeyInfo } from './verifier.ts';

/** HTTP client used by devices (and by tests through the in-process port). */
export class HttpReportVerifierClient implements ReportVerifierPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async attest(req: AttestRequest): Promise<AttestResult | AttestFailure> {
    const res = await this.fetchImpl(new URL('/attest', this.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const body = (await res.json()) as AttestResult | AttestFailure;
    return body;
  }
  /** The verifier's address, public key, chain table (chain → signing domain) and retired addresses (`GET /keys`). */
  async publicKey(): Promise<VerifierKeyInfo> {
    const res = await this.fetchImpl(new URL('/keys', this.baseUrl));
    return (await res.json()) as VerifierKeyInfo;
  }
}

export type { ReportAttestationRecord };

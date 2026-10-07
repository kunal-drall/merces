import type { VerifierAttestation } from '@merces/domain';
import type { AttestFailure, AttestRequest, AttestResult, ReportVerifierPort } from './verifier.ts';

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
  async publicKey(): Promise<{ keyId: string; spkiHex: string; rawHex: string }> {
    const res = await this.fetchImpl(new URL('/keys', this.baseUrl));
    return (await res.json()) as { keyId: string; spkiHex: string; rawHex: string };
  }
}

export type { VerifierAttestation };

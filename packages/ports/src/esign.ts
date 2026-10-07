import { createHash } from 'node:crypto';

/**
 * E-signature port (E3). Produces an envelope from the rendered contract bundle, collects the issuer's signature,
 * and returns the signed document. The real provider is an open question (Part J.1); the mock signs instantly
 * when `complete()` is called and returns a signed bundle whose hash is anchored onchain.
 */
export interface ESignPort {
  readonly provider: string;
  createEnvelope(params: { sessionId: string; signerAccountId: string; documents: { name: string; body: string }[] }): Promise<{ envelopeId: string; signingUrl: string }>;
  status(envelopeId: string): Promise<'sent' | 'signed' | 'declined' | 'expired'>;
  /** the signed bundle (provider-specific bytes; here a text bundle with an audit trail) */
  signedDocument(envelopeId: string): Promise<{ body: string; completedAt: string } | null>;
}

export class MockESign implements ESignPort {
  readonly provider = 'mock';
  private readonly envelopes = new Map<string, { documents: { name: string; body: string }[]; state: 'sent' | 'signed' | 'declined' | 'expired'; signer: string; signedBody?: string; completedAt?: string }>();
  async createEnvelope(params: { sessionId: string; signerAccountId: string; documents: { name: string; body: string }[] }): Promise<{ envelopeId: string; signingUrl: string }> {
    const envelopeId = `mockenv_${params.sessionId}`;
    this.envelopes.set(envelopeId, { documents: params.documents, state: 'sent', signer: params.signerAccountId });
    return { envelopeId, signingUrl: `https://esign.mock.invalid/sign/${envelopeId}` };
  }
  async status(envelopeId: string): Promise<'sent' | 'signed' | 'declined' | 'expired'> {
    return this.envelopes.get(envelopeId)?.state ?? 'expired';
  }
  async signedDocument(envelopeId: string): Promise<{ body: string; completedAt: string } | null> {
    const e = this.envelopes.get(envelopeId);
    return e?.state === 'signed' && e.signedBody ? { body: e.signedBody, completedAt: e.completedAt! } : null;
  }
  /** Simulates the signer completing the envelope (in production this is the provider's webhook). */
  async complete(envelopeId: string, outcome: 'signed' | 'declined' = 'signed', at: Date = new Date()): Promise<void> {
    const e = this.envelopes.get(envelopeId);
    if (!e) throw new Error('unknown envelope');
    e.state = outcome;
    if (outcome === 'signed') {
      e.completedAt = at.toISOString();
      const audit = `\n\n--- SIGNATURE AUDIT TRAIL (mock) ---\nSigner: ${e.signer}\nCompleted: ${e.completedAt}\nEnvelope: ${envelopeId}\nDocument hash: ${createHash('sha256').update(e.documents.map((d) => d.body).join('\n')).digest('hex')}\n`;
      e.signedBody = e.documents.map((d) => `=== ${d.name} ===\n${d.body}`).join('\n\n') + audit;
    }
  }
}

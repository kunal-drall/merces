import { createHash } from 'node:crypto';

/**
 * zkTLS port (E5). Shaped after Reclaim Protocol's JS SDK 5.x (verified 2026-10-07, see VERSIONS.md):
 * a verification request is created for a provider, the user's device produces a proof, the backend verifies it
 * with `verifyProof`. The real adapter in reclaim.ts requires a reviewed, pinned income provider.
 *
 * Privacy: `verify()` returns the attested figure IN MEMORY to its caller. The only caller is the report
 * verifier, which keeps no database and logs no payloads. With Reclaim's `responseRedactions[].hash: 'oprf'`
 * option the provider can attest a hash of the figure instead, and `figure` comes back null with `figureHash` set.
 */
export type IncomeSourceKind = 'stripe' | 'deel' | 'distrokid';

/** Reclaim-shaped proof (field names from the official "anatomy of a proof"). */
export interface ZkTlsProof {
  system: 'reclaim' | 'tlsnotary' | 'mock';
  identifier: string;
  claimData: {
    provider: string;
    parameters: string;
    owner: string;
    timestampS: number;
    /** JSON string: { contextAddress, contextMessage, reclaimSessionId, extractedParameters, providerHash } */
    context: string;
    identifier: string;
    epoch: number;
  };
  signatures: string[];
  witnesses: { id: string; url: string }[];
  extractedParameterValues: Record<string, string>;
}

export interface ZkTlsVerification {
  ok: boolean;
  source: IncomeSourceKind;
  /** attested gross covered income, in income-currency base units (6 decimals); null when the provider attested a hash */
  figure: bigint | null;
  figureHash: string | null;
  currency: string;
  /** the period end the figure covers (YTD up to this unix time) */
  coversUntil: number;
  sessionId: string;
  providerHash: string;
  error?: string;
}

export interface ZkTlsPort {
  readonly provider: 'reclaim' | 'tlsnotary' | 'mock';
  createSession(params: { source: IncomeSourceKind; seriesId: string; periodId: string; coversUntil: number; year: number }): Promise<{ sessionId: string; requestUrl: string; statusUrl: string }>;
  verify(proof: ZkTlsProof, expect: { seriesId: string; periodId: string }): Promise<ZkTlsVerification>;
}

/** HTTP provider definitions in Reclaim's custom-provider shape (url, method, responseMatches, responseRedactions). */
export interface SourceDefinition {
  kind: IncomeSourceKind;
  name: string;
  /** Reclaim provider id when one exists in the catalogue; custom providers carry null */
  reclaimProviderId: string | null;
  http: {
    url: string;
    method: 'GET' | 'POST';
    responseMatches: { type: 'regex' | 'contains'; value: string }[];
    /** named regex groups are extracted; with hash: 'oprf' the attestor signs a hash instead of the value */
    responseRedactions: { regex?: string; jsonPath?: string; xPath?: string; hash?: 'oprf' | 'oprf-mpc' | 'oprf-raw' }[];
  };
  /** which extracted parameter carries the figure, and its unit */
  figureParameter: string;
  figureUnit: 'cents' | 'base6';
  currencyParameter: string | null;
  defaultCurrency: string;
  notes: string;
}

/** Build order per the brief: Stripe, then Deel, then DistroKid. */
export const SOURCE_DEFINITIONS: Record<IncomeSourceKind, SourceDefinition> = {
  stripe: {
    kind: 'stripe',
    name: 'Stripe (balance transactions)',
    reclaimProviderId: null, // A reviewed YTD provider is required; the catalogue's last transaction is not income coverage.
    http: {
      url: 'https://api.stripe.com/v1/balance_transactions?type=charge&limit=100&created[gte]={{yearStart}}&created[lte]={{coversUntil}}',
      method: 'GET',
      responseMatches: [{ type: 'contains', value: '"object": "list"' }],
      responseRedactions: [{ jsonPath: '$.data[*].amount' }, { jsonPath: '$.data[*].currency' }],
    },
    figureParameter: 'grossIncome',
    figureUnit: 'cents',
    currencyParameter: 'currency',
    defaultCurrency: 'USD',
    notes: 'Gross charge amounts summed year-to-date; refunds are excluded by type=charge. Stripe test mode keys (sk_test_) only.',
  },
  deel: {
    kind: 'deel',
    name: 'Deel (payments)',
    reclaimProviderId: null,
    http: {
      url: 'https://api.letsdeel.com/rest/v2/payments',
      method: 'GET',
      responseMatches: [{ type: 'contains', value: '"data"' }],
      responseRedactions: [{ jsonPath: '$.data[*].total' }, { jsonPath: '$.data[*].currency' }],
    },
    figureParameter: 'grossIncome',
    figureUnit: 'base6',
    currencyParameter: 'currency',
    defaultCurrency: 'USD',
    notes: 'Deel exposes invoices/payments to the paying client; the contractor-side earnings endpoint is unconfirmed (VERSIONS.md). Custom provider.',
  },
  distrokid: {
    kind: 'distrokid',
    name: 'DistroKid (royalty earnings)',
    reclaimProviderId: null,
    http: {
      url: 'https://distrokid.com/bank/',
      method: 'GET',
      responseMatches: [{ type: 'regex', value: 'Earnings' }],
      responseRedactions: [{ regex: '(?<grossIncome>[0-9][0-9,]*\\.[0-9]{2})', hash: 'oprf' }],
    },
    figureParameter: 'grossIncome',
    figureUnit: 'cents',
    currencyParameter: null,
    defaultCurrency: 'USD',
    notes: 'DistroKid has no public API; the provider attests the earnings page over TLS. Custom provider; HTML layout must be re-verified against the live site.',
  },
};

function mockSignature(secret: string, proof: Omit<ZkTlsProof, 'signatures'>): string {
  return '0x' + createHash('sha256').update(secret).update(JSON.stringify({ c: proof.claimData, e: proof.extractedParameterValues })).digest('hex');
}

/**
 * Mock zkTLS: proofs are produced from synthetic source data with `prove()` and verified by a shared secret.
 * The shape is Reclaim's so swapping in the real SDK touches only this file.
 */
export class MockZkTls implements ZkTlsPort {
  readonly provider = 'mock' as const;
  constructor(private readonly secret = 'mock-attestor-secret') {}

  async createSession(params: { source: IncomeSourceKind; seriesId: string; periodId: string; coversUntil: number; year: number }): Promise<{ sessionId: string; requestUrl: string; statusUrl: string }> {
    const sessionId = `mocksess_${params.source}_${params.seriesId}_${params.periodId}`;
    return { sessionId, requestUrl: `https://zktls.mock.invalid/verify/${sessionId}`, statusUrl: `https://zktls.mock.invalid/status/${sessionId}` };
  }

  /** "Device side": produce a proof attesting `figure` (base-6 units) for a source. */
  prove(params: { source: IncomeSourceKind; seriesId: string; periodId: string; figure: bigint; currency: string; coversUntil: number; owner: string; sessionId?: string; hashOnly?: boolean }): ZkTlsProof {
    const def = SOURCE_DEFINITIONS[params.source];
    const figureHash = '0x' + createHash('sha256').update(`oprf:${params.figure}`).digest('hex');
    const extracted: Record<string, string> = params.hashOnly ? { [def.figureParameter]: figureHash, currency: params.currency } : { [def.figureParameter]: params.figure.toString(), currency: params.currency };
    const sessionId = params.sessionId ?? `mocksess_${params.source}_${params.seriesId}_${params.periodId}`;
    const context = JSON.stringify({ contextAddress: '0x0', contextMessage: `${params.seriesId}|${params.periodId}|${params.coversUntil}`, reclaimSessionId: sessionId, extractedParameters: extracted, providerHash: '0x' + createHash('sha256').update(JSON.stringify(def.http)).digest('hex'), hashOnly: !!params.hashOnly });
    const base = {
      system: 'mock' as const,
      identifier: '0x' + createHash('sha256').update(context).digest('hex'),
      claimData: { provider: 'http', parameters: JSON.stringify(def.http), owner: params.owner, timestampS: params.coversUntil, context, identifier: '0x' + createHash('sha256').update(context).digest('hex'), epoch: 1 },
      witnesses: [{ id: 'mock-witness', url: 'https://zktls.mock.invalid/witness' }],
      extractedParameterValues: extracted,
    };
    return { ...base, signatures: [mockSignature(this.secret, base)] };
  }

  async verify(proof: ZkTlsProof, expect: { seriesId: string; periodId: string }): Promise<ZkTlsVerification> {
    const fail = (error: string): ZkTlsVerification => ({ ok: false, source: 'stripe', figure: null, figureHash: null, currency: '', coversUntil: 0, sessionId: '', providerHash: '', error });
    if (proof.system !== 'mock') return fail(`mock verifier cannot verify a ${proof.system} proof`);
    const { signatures, ...rest } = proof;
    if (signatures[0] !== mockSignature(this.secret, rest)) return fail('bad attestor signature');
    let ctx: { contextMessage: string; reclaimSessionId: string; providerHash: string; hashOnly?: boolean };
    try {
      ctx = JSON.parse(proof.claimData.context);
    } catch {
      return fail('bad context');
    }
    const [seriesId, periodId, until] = ctx.contextMessage.split('|');
    if (seriesId !== expect.seriesId || periodId !== expect.periodId) return fail('proof is for another series or period (replay)');
    const def = Object.values(SOURCE_DEFINITIONS).find((d) => '0x' + createHash('sha256').update(JSON.stringify(d.http)).digest('hex') === ctx.providerHash);
    if (!def) return fail('unknown provider hash');
    const raw = proof.extractedParameterValues[def.figureParameter];
    if (raw === undefined) return fail('figure missing');
    const currency = proof.extractedParameterValues[def.currencyParameter ?? 'currency'] ?? def.defaultCurrency;
    if (ctx.hashOnly) return { ok: true, source: def.kind, figure: null, figureHash: raw, currency, coversUntil: Number(until), sessionId: ctx.reclaimSessionId, providerHash: ctx.providerHash };
    if (!/^\d+$/.test(raw)) return fail('figure is not an integer');
    return { ok: true, source: def.kind, figure: BigInt(raw), figureHash: null, currency, coversUntil: Number(until), sessionId: ctx.reclaimSessionId, providerHash: ctx.providerHash };
  }
}

export { ReclaimZkTls } from './reclaim.ts';

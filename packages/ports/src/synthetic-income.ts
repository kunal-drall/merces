import { assertSigningNetwork, type SigningDomain } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { MockZkTls, type ZkTlsPort, type ZkTlsProof, type IncomeSourceKind, type ZkTlsVerification } from './zktls.ts';

export const SYNTHETIC_INCOME_NOTICE = 'Synthetic Stripe transactions and simulated Reclaim verification. Test data only; no income has been verified with either provider.';
export const SYNTHETIC_INCOME_VERSION = 'merces/synthetic-stripe/v1';

/** This opt-in demonstration is limited to the two release test networks. */
export function assertSyntheticIncomeNetwork(domain: SigningDomain): void {
  assertSigningNetwork(domain);
  if (!(domain.chainKind === 1 && domain.chainId === '103' || domain.chainKind === 2 && domain.chainId === '10143')) {
    throw Error('Synthetic income is limited to Solana devnet and Monad testnet.');
  }
}

/** Public deterministic fixture: two USD charges ($100 and $250) per quarter, no real Stripe request. */
export class SyntheticIncomeZkTls implements ZkTlsPort {
  readonly provider = 'mock' as const;
  readonly testOnly = true;
  private readonly mock = new MockZkTls(SYNTHETIC_INCOME_VERSION);
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  fixture(seriesId: string, periodId: string): { testOnly: true; notice: string; fixtureVersion: string; proof: ZkTlsProof } {
    if (!/^[a-z0-9-]+:[^|\s]+$/.test(seriesId)) throw Error('Invalid synthetic series.');
    const period = parsePeriod(periodId);
    if (period.end > this.now()) throw Error('Synthetic income cannot cover a future quarter.');
    const quarter = Number(periodId.at(-1));
    const proof = this.mock.prove({source:'stripe',seriesId,periodId,figure:350_000_000n * BigInt(quarter),currency:'USD',coversUntil:period.end,owner:'synthetic-issuer'});
    return {testOnly:true,notice:SYNTHETIC_INCOME_NOTICE,fixtureVersion:SYNTHETIC_INCOME_VERSION,proof};
  }

  async createSession(params: {source: IncomeSourceKind; seriesId: string; periodId: string; coversUntil: number; year: number}) {
    if (params.source !== 'stripe') throw Error('Only the synthetic Stripe fixture is enabled.');
    const period = parsePeriod(params.periodId);
    if (params.coversUntil !== period.end || params.year !== period.year) throw Error('Synthetic period mismatch.');
    const {proof} = this.fixture(params.seriesId,params.periodId);
    const sessionId = JSON.parse(proof.claimData.context).reclaimSessionId as string;
    return {sessionId,requestUrl:'https://synthetic.merces.invalid/fixture',statusUrl:'https://synthetic.merces.invalid/status'};
  }

  async verify(proof: ZkTlsProof, expect: {seriesId: string; periodId: string}): Promise<ZkTlsVerification> {
    const fail = (): ZkTlsVerification => ({ok:false,source:'stripe',figure:null,figureHash:null,currency:'',coversUntil:0,sessionId:'',providerHash:'',error:'not the fixed synthetic fixture'});
    try {
      const expected = this.fixture(expect.seriesId,expect.periodId).proof;
      // Check the complete fixture, including its source, amount, period, owner and witness. No user-supplied income.
      for (const field of ['system','identifier','claimData','signatures','witnesses','extractedParameterValues'] as const) {
        if (JSON.stringify(proof[field]) !== JSON.stringify(expected[field])) return fail();
      }
      return this.mock.verify(proof,expect);
    } catch { return fail(); }
  }
}

export function incomeProviderFromEnv(env: NodeJS.ProcessEnv, opts: {simulatorOnly: boolean}): ZkTlsPort {
  const provider = env.MERCES_ZKTLS_PROVIDER ?? 'mock';
  if (provider === 'synthetic' && env.MERCES_TEST_INCOME === 'true') return new SyntheticIncomeZkTls();
  if (provider !== 'mock') throw Error('Income provider unavailable; synthetic requires MERCES_TEST_INCOME=true.');
  if (!opts.simulatorOnly) throw Error('mock zkTLS is simulator-only: choose a real provider or the explicit synthetic testnet demo.');
  return new MockZkTls();
}

import { afterAll, describe, expect, it } from 'vitest';
import { Groth16ReportVerifier, shutdownProofSystem } from '@merces/ports';
import { SimulatorChain } from '@merces/simulator';
import { seedCohort } from '../src/seed.ts';

const GENESIS = Date.UTC(2026, 0, 1) / 1000;

afterAll(shutdownProofSystem);

describe('seedCohort: the pilot cohort reports through the issuer devices (S1 WP10)', () => {
  it('every tier (split router, zkTLS + verifier, attestor co-signed), FX fallbacks and a liquidity event are accepted on both personalities', async () => {
    const proofs = (process.env.MERCES_SEED_TEST_PROOFS ?? 'mock') as 'mock' | 'groth16';
    const groth16 = new Groth16ReportVerifier();
    const sims = {
      solana: SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana', genesis: GENESIS, reportProofVerifier: groth16, acceptMockProofs: proofs === 'mock' }),
      monad: SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad', genesis: GENESIS, reportProofVerifier: groth16, acceptMockProofs: proofs === 'mock' }),
    };
    const seeded = await seedCohort(sims, { quarters: 3, proofs });
    expect(seeded.issuers).toHaveLength(12);
    for (const s of seeded.issuers) {
      const series = (await sims[s.issuer.chain].getSeries(s.seriesId))!;
      expect(series.reporting.lastAcceptedPeriod, s.issuer.handle).toBe('2026Q3');
      expect(series.reporting.openDueAmount, s.issuer.handle).toBe('0');
    }
    const events = [...sims.solana.engine.events, ...sims.monad.engine.events].filter((e) => e.type === 'ReportAccepted').map((e) => e.payload as { tier: number; liquidityEvent: boolean; fxBasis: string });
    expect(events).toHaveLength(36);
    expect(new Set(events.map((e) => e.tier))).toEqual(new Set([1, 2, 3]));
    expect(events.some((e) => e.liquidityEvent)).toBe(true);
    expect(events.some((e) => e.fxBasis === 'attestor')).toBe(true);
  });
});

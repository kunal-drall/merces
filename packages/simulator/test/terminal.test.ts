import { describe, expect, it } from 'vitest';
import { termsCommitment } from '@merces/domain';
import { parsePeriod, ratePerUnit, wadFromDecimal } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

describe('amendments and extinguishment', () => {
  it('allows only issuer-favourable amendments with an attestor, and extinguishes with two attestors', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const r = ratePerUnit(privateTerms.shareRateWad, 500n);
    const newCommitment = termsCommitment({ threshold: privateTerms.threshold * 103n / 100n, ratePerUnitWad: r, reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: privateTerms.salt });
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.5').toString(), attestor: h.attestors[0]!.address }), 'Unauthorized');
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.6').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]), 'InvalidTerms');
    const ok = await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.4').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    expect(types(ok.events)).toEqual(['TermsAmended']);
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.terms.termsCommitment).toBe(newCommitment);
    expect(s.capPerUnit).toBe((USDC(9) * 24n / 10n).toString());
    // old commitment no longer accepted
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await expect(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n)).rejects.toThrow(/commitment/);
    // extinguishment: two attestors, unreleased treasury to holders
    await expectChainError(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }), 'Unauthorized');
    const ex = await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    const returned = (ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders;
    expect(returned).toBe(USDC(4500).toString());
    const pos = (await h.sim.getPosition(seriesId, h.backers[2]!.address))!;
    expect(pos.claimable).toBe(USDC(900).toString());
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'WrongStatus');
  });
});

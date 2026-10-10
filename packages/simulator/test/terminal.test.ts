import { describe, expect, it } from 'vitest';
import { termsCommitment } from '@merces/domain';
import { parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

describe('amendments and extinguishment', () => {
  it('allows only issuer-favourable amendments with an attestor, and extinguishes with two attestors', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const newCommitment = termsCommitment({ ...privateTerms, theta: privateTerms.theta * 103n / 100n });
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.5').toString(), attestor: h.attestors[0]!.address }), 'Unauthorized');
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.6').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]), 'InvalidTerms');
    const ok = await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.4').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    expect(types(ok.events)).toEqual(['TermsAmended']);
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.terms.termsCommitment).toBe(newCommitment);
    expect(s.capPerUnit).toBe((USDC(9) * 24n / 10n).toString());
    // a proof over the old terms no longer matches the live commitment (vector 14)
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n), 'InvalidProof');
    // extinguishment: two attestors, unreleased treasury to holders
    await expectChainError(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }), 'Unauthorized');
    const ex = await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    const returned = (ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders;
    expect(returned).toBe(USDC(4500).toString());
    const pos = (await h.sim.getPosition(seriesId, h.backers[2]!.address))!;
    expect(pos.claimable).toBe(USDC(900).toString());
    // the burn crank refuses an Extinguished series (Stage 1 burn_retired: TerminalStatus); its units burn on claim
    await expectStage1Error(h.sim.submit({ kind: 'crankBurn', seriesId, holders: [h.backers[2]!.address] }, 'keeper'), 'TerminalStatus');
    const claim = await h.exec(h.backers[2]!, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(claim.events[1]!.payload).toMatchObject({ units: '100', reason: 'extinguishment' });
    // releases are no longer refused for being Extinguished (Stage 1 claim_release): vested tranches stay drawable up to
    // what had vested at the extinguishment. Today's extinguishment still returns the whole treasury, so nothing is
    // left to draw (WP7 returns only the unvested part).
    await expectStage1Error(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'NothingVested');
  });
});

import { describe, expect, it } from 'vitest';
import { ChainError } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, expectChainError } from './helpers.ts';

describe('autonomy charter invariants (C11)', () => {
  it('C11.1 releases follow the schedule with no approval; only Late or the issuer pause them', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    await h.exec(h.issuer, { kind: 'pauseReleases', seriesId, paused: true });
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'Paused');
    await h.exec(h.issuer, { kind: 'pauseReleases', seriesId, paused: false });
    await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    // nobody else can pause: attestor/admin/backer have no such command path (the only pause inputs are the issuer flag and Late)
    const tx = await h.sim.build({ kind: 'pauseReleases', seriesId, paused: true }, h.admin.address);
    await expectChainError(h.sim.send({ tx, signatures: { [h.admin.address]: `sim:${h.admin.address}` } }), 'Unauthorized');
  });
  it('C11.3 reporting zero carries no penalty and C11.5 the issuer can stop new issuance', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const zero = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n);
    expect(zero.due).toBe(0n);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    await h.exec(h.issuer, { kind: 'stopIssuance' });
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms }), 'NotPermitted');
  });
  it('C11.7 the admin cannot touch a live series, move funds or block claims', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const forbidden = [
      { kind: 'drawRelease', seriesId },
      { kind: 'redeem', seriesId, maxPricePerUnit: '1' },
      { kind: 'claimPayout', seriesId },
      { kind: 'requestPause', seriesId, until: 9_999_999_999 },
    ] as const;
    for (const cmd of forbidden) {
      const tx = await h.sim.build(cmd, h.admin.address);
      await expect(h.sim.send({ tx, signatures: { [h.admin.address]: `sim:${h.admin.address}` } })).rejects.toBeInstanceOf(ChainError);
    }
    // and a failed tx leaves no trace
    const before = (await h.sim.readEvents(null, 10_000)).events.length;
    await expect(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '1' })).rejects.toBeInstanceOf(ChainError);
    expect((await h.sim.readEvents(null, 10_000)).events.length).toBe(before);
  });
});

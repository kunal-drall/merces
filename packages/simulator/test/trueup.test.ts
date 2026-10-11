import { describe, it, expect } from 'vitest';
import type { UserCommand } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { SimHarness, serialiseState } from '../src/index.ts';
import { seedPause, seriesOf } from './kit.ts';
import { expectStage1Error } from './helpers.ts';

describe.each(['solana', 'monad'] as const)('%s annual true-up contract guards', (personality) => {
  it('checks signatures, live nonces, future timestamps, terminal state, and paused accrual atomically', async () => {
    const h = await SimHarness.create(personality, { genesis: parsePeriod('2028Q1').start });
    const { seriesId } = await h.runRaise();
    const sign = async (year: number, adjustment: string, timestamp?: number): Promise<Extract<UserCommand, { kind: 'submitTrueUp' }>> => {
      const ts = timestamp ?? await h.sim.now();
      const s = (await h.sim.getSeries(seriesId))!;
      const sig = await h.attestors[0]!.attest('TRUEUP', (await h.sim.info()).signing!, s.seriesKey, { trueupNonce: s.nonces.trueup, year, adjustment, attestationTs: String(ts) });
      return { kind: 'submitTrueUp', seriesId, year, adjustment, attestationTs: String(ts), attestor: sig.signer, signature: sig.signature };
    };
    const now = await h.sim.now();
    const before = serialiseState(h.sim.state);
    await expectStage1Error(h.exec(h.issuer, await sign(2026, '100000000', now + 1)), personality === 'solana' ? 'TrueUpTimestampInFuture' : 'AttestationInFuture');
    expect(serialiseState(h.sim.state)).toBe(before);
    await expectStage1Error(h.exec(h.backers[0]!, await sign(2026, '0')), 'NotIssuer');
    await expectStage1Error(h.exec(h.issuer, await sign(2026, '-1')), 'TrueUpAdjustmentTooLarge');
    const cmd = await sign(2026, '100000000');
    await h.exec(h.issuer, cmd);
    await expectStage1Error(h.exec(h.issuer, cmd), 'InvalidAttestorSignature');
    await expectStage1Error(h.exec(h.issuer, await sign(2027, '0')), 'TrueUpOutstanding');
    seedPause(h.sim, seriesId, now, now + 10 * 86400);
    await h.sim.setTime(now + 70 * 86400);
    expect((await h.sim.getSeries(seriesId))!.trueUp.accrual).toBe('0');
    await h.sim.advanceTime(86400);
    const total = BigInt((await h.sim.getSeries(seriesId))!.trueUp.total);
    expect(total).toBeGreaterThan(100000000n);
    const paid = await h.exec(h.backers[0]!, { kind: 'payTrueUp', seriesId });
    expect(paid.events.find((e) => e.type === 'TrueUpPaid')!.payload).toMatchObject({ amount: total.toString() });
    expect((await h.sim.getSeries(seriesId))!.trueUp).toMatchObject({ due: '0', year: null, lastYear: 2026 });
    await expectStage1Error(h.exec(h.issuer, await sign(2026, '0')), 'TrueUpYearInvalid');
    seriesOf(h.sim, seriesId).status = 'Retired';
    await expectStage1Error(h.exec(h.issuer, await sign(2027, '0')), 'TerminalStatus');
  });
});

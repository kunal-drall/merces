import { describe, expect, it } from 'vitest';
import { SimHarness, SimulatorChain, defaultTerms } from '../src/index.ts';
import { USDC, expectChainError } from './helpers.ts';

describe('simulator personalities', () => {
  it('monad has USDC only; solana has USDC and USDG; addresses have the right shape', async () => {
    const sol = SimulatorChain.createSync({ personality: 'solana' });
    const mon = SimulatorChain.createSync({ personality: 'monad' });
    expect(Object.keys((await sol.info()).stablecoins).sort()).toEqual(['USDC', 'USDG']);
    expect(Object.keys((await mon.info()).stablecoins)).toEqual(['USDC']);
    expect(mon.admin).toMatch(/^0x[0-9a-f]{40}$/);
    expect(sol.admin).not.toMatch(/^0x/);
    const h = await SimHarness.create('monad');
    const { terms } = defaultTerms(sol, { stablecoin: 'USDG' });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: { ...terms, stablecoinMint: terms.stablecoinMint } }), 'InvalidTerms');
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: { ...defaultTerms(h.sim).terms, raiseStyle: 'curve' } }), 'InvalidTerms');
  });
  it('solana can raise in USDG', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId } = await h.runRaise({ terms: { stablecoin: 'USDG', stablecoinMint: h.sim.mintOf('USDG') } });
    expect((await h.sim.getSeries(seriesId))!.terms.stablecoin).toBe('USDG');
    expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDG')).toBe(USDC(45).toString());
  });
});

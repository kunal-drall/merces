import { describe, expect, it } from 'vitest';
import { conformanceTargets, envFor } from '../src/env.ts';

describe('conformance targets', () => {
  it('maps CONFORMANCE_CHAIN to one describe per target, so a single chain runs the suite once', () => {
    expect(conformanceTargets('simulator')).toEqual(['simulator:solana', 'simulator:monad']);
    expect(conformanceTargets('simulator:monad')).toEqual(['simulator:monad']);
    expect(conformanceTargets('solana')).toEqual(['solana']);
    expect(conformanceTargets('evm:monad-testnet')).toEqual(['evm:monad-testnet']);
  });
  it('builds an env named after its target and rejects unknown targets', async () => {
    const e = await envFor('simulator:monad');
    expect(e.name).toBe('simulator:monad');
    await e.close();
    await expect(envFor('mainnet')).rejects.toThrow(/unknown CONFORMANCE_CHAIN target/);
  });
});

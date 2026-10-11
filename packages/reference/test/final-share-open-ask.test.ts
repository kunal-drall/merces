import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/simulator.js';
import type { Vector } from '../src/sim/types.js';

describe('DIV-S1I-1: final share after redemption with an open ask', () => {
  it('pays the escrowed units their final share and empties the vault, matching both chain implementations', async () => {
    // Proposed vector 26 preserves the chain-derived values from MercesVault.sol and claims.rs.
    const vector = JSON.parse(readFileSync(new URL('./fixtures/26_final_share_open_ask.json', import.meta.url), 'utf8')) as Vector;
    const sim = new Simulator({ flags: vector.config.flags });
    await sim.run(vector.steps);
    expect(sim.series.get('S2')!.vaultBalance).toBe(0n);
    expect(sim.account('b1').stable).toBe(75_036_935_800n);
    sim.checkUnitSupply('S2');
  }, 120_000);
});

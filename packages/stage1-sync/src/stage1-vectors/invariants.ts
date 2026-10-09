import { RunnerError, nonProtocol } from './errors.ts';
import type { World } from './world.ts';

/**
 * Conservation checks the runner makes on every replay (S1 plan §5.2; Stage 1 `reference/test/vectors.test.ts:43-50`).
 * Each returns null when the invariant holds, else a message with public numbers only.
 */

/** After every step: Σ(actors' stablecoin + fee collector + treasury + vault + auction escrow + window escrow + router) = Σ fund. */
export function stableConserved(world: World, funded: bigint): string | null {
  const total = world.totalStable();
  return total === funded ? null : `stablecoin not conserved: the accounts and pools hold ${total}, ${funded} was funded`;
}

/** At each `expect` with a series: holder units + auction and window escrows = the series' unit supply (SIM:1833-1839). */
export function unitsConserved(world: World, series: string): string | null {
  try {
    world.checkUnitSupply(series);
    return null;
  } catch (e) {
    return e instanceof RunnerError ? `${series}: ${e.message}` : `${series}: unit supply check raised ${nonProtocol(e).className}`;
  }
}

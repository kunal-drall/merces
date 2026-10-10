import type { ChainFamily } from '@merces/domain';
import { SimWallet, deriveAddress, simAdminWallet } from '@merces/simulator';

/**
 * Vector actors as simulator wallets (S1 plan §5.1 `actors.ts`, target-vectors reader §7).
 *
 * Every name a vector uses (`issuer`, `b1`, `keeper`, `attestor1`, `verifier1`, …) maps to a fresh
 * `SimWallet(family, 'v:<vector>:<name>')`, so two vectors never share a wallet and both personalities derive
 * addresses of their own family. `keeper` is an ordinary wallet: Stage 1 uses it as the permissionless caller of
 * user-shaped calls (`claim` by a non-holder). The admin multisig is `simAdminWallet`; the allowlist manager and the
 * keeper role submit service commands. The fee collector is the chain's own `state.feeCollector`, not an actor.
 */
export class Actors {
  readonly admin: SimWallet;
  private readonly wallets = new Map<string, SimWallet>();
  private readonly names = new Map<string, string>();

  constructor(
    readonly family: ChainFamily,
    readonly vectorName: string,
    known: readonly string[] = [],
  ) {
    this.admin = simAdminWallet(family);
    for (const n of known) this.wallet(n);
  }

  /** The wallet of a vector name (created on first use). */
  wallet(name: string): SimWallet {
    let w = this.wallets.get(name);
    if (!w) {
      w = new SimWallet(this.family, `v:${this.vectorName}:${name}`);
      this.wallets.set(name, w);
      this.names.set(w.address, name);
    }
    return w;
  }

  address(name: string): string {
    return this.wallet(name).address;
  }

  /** The vector name of an address, or null for an address no vector name maps to. */
  nameOf(address: string): string | null {
    return this.names.get(address) ?? null;
  }

  /** Every name seen so far, sorted. */
  all(): string[] {
    return [...this.wallets.keys()].sort();
  }

  /** The deterministic series address for a vector's series name (`createSeries.seriesAddressHint`). */
  seriesAddress(series: string): string {
    return deriveAddress(this.family, `v:${this.vectorName}:series:${series}`);
  }
}

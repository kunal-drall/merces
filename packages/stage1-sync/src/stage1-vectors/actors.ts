import type { ChainFamily } from '@merces/domain';
import { SimWallet, deriveAddress, simAdminWallet } from '@merces/simulator';
import { RunnerError } from './errors.ts';

/**
 * Vector actors as simulator wallets (S1 plan §5.1 `actors.ts`, target-vectors reader §7).
 *
 * Every name a vector uses (`issuer`, `b1`, `keeper`, `attestor1`, `verifier1`, …) maps to a fresh
 * `SimWallet(family, 'v:<vector>:<name>')`, so two vectors never share a wallet and both personalities derive
 * addresses of their own family. `keeper` is an ordinary wallet: Stage 1 uses it as the permissionless caller of
 * user-shaped calls (`claim` by a non-holder). The admin multisig is `simAdminWallet`; the allowlist manager and the
 * keeper role submit service commands. The fee collector is the chain's own `state.feeCollector`, not an actor.
 *
 * A name the vector gives a key (`keys[name]`: `attestor1`, `attestor2`, `verifier1`, …) is that key's 20-byte address
 * on both personalities (S4 WP5): `register_attestor` registers `keys[name].address`, as Stage 1's harnesses do
 * (vectors README:48-50). Its wallet is the **transitional co-signing wallet** at the key's address, which no flow uses
 * any more: every attestation is the key's own Stage 1 signature (tier-3 and FX reports since S4 WP9, the pause
 * approval WP10, the amendment WP11, the extinguishment WP12). It is gone in S4 WP13 with `coSigners`.
 */
export class Actors {
  readonly admin: SimWallet;
  private readonly wallets = new Map<string, SimWallet>();
  private readonly names = new Map<string, string>();

  constructor(
    readonly family: ChainFamily,
    readonly vectorName: string,
    known: readonly string[] = [],
    private readonly keys: Readonly<Record<string, { address?: unknown }>> = {},
  ) {
    this.admin = simAdminWallet(family);
    for (const n of known) this.wallet(n);
  }

  /** The 20-byte address of vector key `name`, lowercase, or undefined when the vector has no such key. */
  keyAddress(name: string): string | undefined {
    const a = this.keys[name]?.address;
    if (a === undefined) return undefined;
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new RunnerError(`the vector's key ${name} has no 20-byte address`);
    return a.toLowerCase();
  }

  /** The wallet of a vector name (created on first use): a key's own address for a name with a vector key. */
  wallet(name: string): SimWallet {
    let w = this.wallets.get(name);
    if (!w) {
      w = new SimWallet(this.family, `v:${this.vectorName}:${name}`, this.keyAddress(name));
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

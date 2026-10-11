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
 * (vectors README:48-50). A key is never a wallet (S4 WP13, cause S4-CS): it signs Stage 1 messages through the
 * `VectorKeyring` and never sends or co-signs a transaction, so a key name has no wallet here (`wallet` refuses one,
 * and the vector's `actors` list, which names its keys too, makes none for them). Nobody co-signs: every attestation
 * is the key's own Stage 1 signature, an argument of the command a wallet or the keeper sends.
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
    for (const n of known) if (!this.isKey(n)) this.wallet(n);
  }

  /** True when `name` is one of the vector's keys (S4 WP5): a signer, never a wallet. */
  isKey(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.keys, name);
  }

  /** The 20-byte address of vector key `name`, lowercase, or undefined when the vector has no such key. */
  keyAddress(name: string): string | undefined {
    const a = this.keys[name]?.address;
    if (a === undefined) return undefined;
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new RunnerError(`the vector's key ${name} has no 20-byte address`);
    return a.toLowerCase();
  }

  /**
   * The wallet of a vector name (created on first use). A vector key has none (S4 WP13): it signs Stage 1 messages and
   * never sends a transaction, so asking for its wallet is a runner error.
   */
  wallet(name: string): SimWallet {
    if (this.isKey(name)) throw new RunnerError(`${name} is a vector key: it signs Stage 1 messages and sends no transaction`);
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

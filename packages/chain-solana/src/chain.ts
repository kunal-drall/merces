import { Connection, PublicKey } from '@solana/web3.js';
import {
  ChainError, type AdminCommand, type ChainInfo, type ChainPort, type DomainEvent, type HealthReport, type ServiceCommand, type ServiceRole, type SignedTx,
  type PermissionlessCommand, type TxResult, type UnsignedTx, type UserCommand,
} from '@merces/domain';
import { assertNotMainnet, checkGenesis, type SolanaChainConfig } from './config.ts';
import { SolanaEventMapper } from './mapping.ts';

/** Stage 1 on Solana: a tally page holds at most 24 Bid accounts (`TALLY_PAGE`, state.rs); no limit on the bid count. */
const SOLANA_LIMITS = { tallyPageMax: 24, maxBidsPerAuction: null } as const satisfies ChainInfo['limits'];

/**
 * SolanaChain — live adapter skeleton. It is an anti-corruption layer: everything Stage 1 actually emits or
 * accepts is mapped here onto the canonical vocabulary. Until `stage1:sync` has generated the typed clients
 * from Stage 1's IDLs, every read and write throws NotImplemented with a pointer to that command.
 *
 * Commitment levels: money-bearing reads and the event stream use `finalized`; `confirmed` is reserved for
 * interface hints (E1).
 */
export class SolanaChain implements ChainPort {
  readonly family = 'solana' as const;
  readonly mode = 'live' as const;
  readonly chain: string;
  readonly connection: Connection;
  readonly mapper: SolanaEventMapper;
  /**
   * True only once reads, event decoding and builders are hooked to the generated Stage 1 clients (D6 step 4).
   * Until then `auto` mode keeps the simulator even when health passes; explicit `live` still constructs this.
   */
  readonly wired: boolean = false;
  private clients: Record<string, unknown> | null = null;
  private networkVerified: Promise<void> | null = null;

  constructor(readonly config: SolanaChainConfig) {
    assertNotMainnet(config);
    this.chain = config.chain;
    this.connection = new Connection(config.rpcUrl, 'finalized');
    this.mapper = new SolanaEventMapper(config);
  }

  /** Loads generated clients if stage1:sync has produced them. */
  async loadGenerated(): Promise<boolean> {
    if (!this.config.generatedDir) return false;
    try {
      const mod = (await import(`${this.config.generatedDir}/index.ts`)) as Record<string, unknown>;
      this.clients = mod;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fails closed unless the RPC's genesis hash is the configured cluster's. Every RPC use goes through this; a
   * success is cached, a failure is retried on the next call.
   */
  ensureNetwork(): Promise<void> {
    this.networkVerified ??= (async () => {
      const hash = await this.connection.getGenesisHash();
      const refusal = checkGenesis(this.config.cluster, hash);
      if (refusal) throw new ChainError('ChainSpecific', refusal, { cluster: this.config.cluster });
    })().catch((e: unknown) => {
      this.networkVerified = null;
      throw e;
    });
    return this.networkVerified;
  }

  private notReady(what: string): never {
    throw new ChainError('NotImplemented', `SolanaChain.${what}: Stage 1 clients are not generated yet (run \`pnpm stage1:sync\`)`, { programs: this.config.programs });
  }

  async info(): Promise<ChainInfo> {
    const stablecoins: ChainInfo['stablecoins'] = {};
    for (const [k, mint] of Object.entries(this.config.stablecoins)) if (mint) stablecoins[k as 'USDC' | 'USDG'] = { mint, decimals: 6 };
    return { chain: this.chain, family: 'solana', mode: 'live', network: this.config.cluster, stablecoins, modules: this.config.programs, admin: '', feeCollector: '', newRaisesPaused: false, limits: SOLANA_LIMITS };
  }

  async health(): Promise<HealthReport> {
    const t0 = Date.now();
    try {
      await this.ensureNetwork();
      const [slot, version] = await Promise.all([this.connection.getSlot('finalized'), this.connection.getVersion()]);
      const programsOk = await this.programsDeployed();
      const latency_ms = Date.now() - t0;
      if (!programsOk.ok) return { ok: false, mode: 'live', latency_ms, detail: `rpc ok (slot ${slot}, ${version['solana-core']}) but programs missing: ${programsOk.missing.join(', ')}` };
      return { ok: true, mode: 'live', latency_ms, detail: `slot ${slot}, solana-core ${version['solana-core']}, ${Object.keys(this.config.programs).length} programs deployed` };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, mode: 'live', latency_ms: Date.now() - t0, detail: msg.startsWith('refusing:') ? msg : `rpc error: ${msg}` };
    }
  }

  async programsDeployed(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    for (const [name, id] of Object.entries(this.config.programs)) {
      try {
        const info = await this.connection.getAccountInfo(new PublicKey(id), 'finalized');
        if (!info || !info.executable) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  async now(): Promise<number> {
    await this.ensureNetwork();
    const slot = await this.connection.getSlot('finalized');
    const t = await this.connection.getBlockTime(slot);
    if (t === null) throw new ChainError('ChainSpecific', 'no block time for finalized slot');
    return t;
  }

  // reads — wired by stage1:sync against the generated clients
  async getIssuer(): Promise<never> { return this.notReady('getIssuer'); }
  async listSeries(): Promise<never> { return this.notReady('listSeries'); }
  async getSeries(): Promise<never> { return this.notReady('getSeries'); }
  async getAuction(): Promise<never> { return this.notReady('getAuction'); }
  async getBid(): Promise<never> { return this.notReady('getBid'); }
  async listBids(): Promise<never> { return this.notReady('listBids'); }
  async getTreasury(): Promise<never> { return this.notReady('getTreasury'); }
  async getVault(): Promise<never> { return this.notReady('getVault'); }
  async getPosition(): Promise<never> { return this.notReady('getPosition'); }
  async listPositions(): Promise<never> { return this.notReady('listPositions'); }
  async getPeriod(): Promise<never> { return this.notReady('getPeriod'); }
  async listPeriods(): Promise<never> { return this.notReady('listPeriods'); }
  async getRedemption(): Promise<never> { return this.notReady('getRedemption'); }
  async getRateAccumulator(): Promise<never> { return this.notReady('getRateAccumulator'); }
  async getQuarterRate(): Promise<never> { return this.notReady('getQuarterRate'); }
  async isAllowlisted(): Promise<never> { return this.notReady('isAllowlisted'); }
  async listAttestors(): Promise<never> { return this.notReady('listAttestors'); }
  async listVerifierKeys(): Promise<never> { return this.notReady('listVerifierKeys'); }
  async getTransferWindow(): Promise<never> { return this.notReady('getTransferWindow'); }
  async getCurve(): Promise<never> { return this.notReady('getCurve'); }
  async getBalance(wallet: string, stablecoin: 'USDC' | 'USDG'): Promise<string> {
    const mint = this.config.stablecoins[stablecoin];
    if (!mint) return '0';
    await this.ensureNetwork();
    const res = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, 'finalized');
    let total = 0n;
    for (const acc of res.value) {
      const amt = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (amt) total += BigInt(amt);
    }
    return total.toString();
  }

  /**
   * Event stream: finalized signatures for each program, oldest first, decoded through the generated
   * clients and mapped by `SolanaEventMapper`. Cursor format: `<slot>:<signature>`.
   */
  async readEvents(_cursor: string | null, _limit: number): Promise<{ events: DomainEvent[]; nextCursor: string | null }> {
    if (!this.clients) return this.notReady('readEvents');
    return this.notReady('readEvents(decoder)');
  }

  async build(_command: UserCommand | AdminCommand | PermissionlessCommand, _signer: string, _coSigners: string[] = []): Promise<UnsignedTx> {
    return this.notReady('build');
  }
  async send(_signed: SignedTx): Promise<TxResult> {
    return this.notReady('send');
  }
  async submit(_command: ServiceCommand, _role: ServiceRole): Promise<TxResult> {
    return this.notReady('submit');
  }
}

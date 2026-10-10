import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from 'viem';
import {
  ChainError, type AdminCommand, type ChainInfo, type ChainPort, type DomainEvent, type HealthReport, type ServiceCommand, type ServiceRole, type SignedTx,
  type PermissionlessCommand, type TxResult, type UnsignedTx, type UserCommand,
} from '@merces/domain';
import { assertNotMainnet, type EvmChainConfig } from './config.ts';
import { EvmEventMapper } from './mapping.ts';

/** Stage 1 on EVM: at most 200 bids per `tallyBids` range and 4,096 bids per auction (MercesConstants.sol). */
const EVM_LIMITS = { tallyPageMax: 200, maxBidsPerAuction: 4096 } as const satisfies ChainInfo['limits'];

/**
 * EvmChain — live adapter skeleton driven purely by chain config (chainId, RPC, contract addresses, ABIs).
 * The same class serves Monad testnet today and Ethereum/Arbitrum/Base/Robinhood Chain later (R23).
 * Money-bearing reads and the event stream use the configured finality tag ('finalized' by default).
 */
export class EvmChain implements ChainPort {
  readonly family = 'evm' as const;
  readonly mode = 'live' as const;
  readonly chain: string;
  readonly client: PublicClient;
  readonly mapper: EvmEventMapper;
  /**
   * True only once reads, event decoding and builders are hooked to the generated Stage 1 ABIs (D6 step 4).
   * Until then `auto` mode keeps the simulator even when health passes; explicit `live` still constructs this.
   */
  readonly wired: boolean = false;
  private abis: Record<string, unknown> | null = null;
  private networkVerified: Promise<void> | null = null;

  constructor(readonly config: EvmChainConfig) {
    assertNotMainnet(config);
    this.chain = config.chain;
    this.client = createPublicClient({ transport: http(config.rpcUrl), chain: { id: config.chainId, name: config.network, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } } });
    this.mapper = new EvmEventMapper(config);
  }

  async loadGenerated(): Promise<boolean> {
    if (!this.config.generatedDir) return false;
    try {
      this.abis = (await import(`${this.config.generatedDir}/index.ts`)) as Record<string, unknown>;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The configured chain id is allow-listed at construction; this checks the RPC actually serves it, so a
   * mainnet endpoint behind a testnet id is refused. A success is cached, a failure is retried on the next call.
   */
  ensureNetwork(): Promise<void> {
    this.networkVerified ??= (async () => {
      const chainId = await this.client.getChainId();
      if (chainId !== this.config.chainId) throw new ChainError('ChainSpecific', `refusing: rpc chainId ${chainId} ≠ configured ${this.config.chainId}`, { chainId });
    })().catch((e: unknown) => {
      this.networkVerified = null;
      throw e;
    });
    return this.networkVerified;
  }

  private notReady(what: string): never {
    throw new ChainError('NotImplemented', `EvmChain.${what}: Stage 1 ABIs are not generated yet (run \`pnpm stage1:sync\`)`, { contracts: this.config.contracts });
  }

  async info(): Promise<ChainInfo> {
    const stablecoins: ChainInfo['stablecoins'] = {};
    for (const [k, addr] of Object.entries(this.config.stablecoins)) if (addr) stablecoins[k as 'USDC' | 'USDG'] = { mint: addr.toLowerCase(), decimals: 6 };
    return { chain: this.chain, family: 'evm', mode: 'live', network: this.config.network, stablecoins, modules: this.config.contracts, admin: '', feeCollector: '', newRaisesPaused: false, limits: EVM_LIMITS };
  }

  async health(): Promise<HealthReport> {
    const t0 = Date.now();
    try {
      await this.ensureNetwork();
      const chainId = this.config.chainId;
      const block = await this.client.getBlock({ blockTag: this.config.finalityTag });
      const missing: string[] = [];
      for (const [name, addr] of Object.entries(this.config.contracts)) {
        const code = await this.client.getCode({ address: getAddress(addr) });
        if (!code || code === '0x') missing.push(name);
      }
      const latency_ms = Date.now() - t0;
      if (missing.length) return { ok: false, mode: 'live', latency_ms, detail: `rpc ok (block ${block.number}) but contracts missing: ${missing.join(', ')}` };
      return { ok: true, mode: 'live', latency_ms, detail: `chainId ${chainId}, ${this.config.finalityTag} block ${block.number}` };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, mode: 'live', latency_ms: Date.now() - t0, detail: msg.startsWith('refusing:') ? msg : `rpc error: ${msg}` };
    }
  }

  async now(): Promise<number> {
    await this.ensureNetwork();
    const b = await this.client.getBlock({ blockTag: this.config.finalityTag });
    return Number(b.timestamp);
  }

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
  async getCurve(): Promise<null> { return null; } // curve mode is Solana-only
  async getBalance(wallet: string, stablecoin: 'USDC' | 'USDG'): Promise<string> {
    const token = this.config.stablecoins[stablecoin];
    if (!token) return '0';
    await this.ensureNetwork();
    const bal = await this.client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(wallet)], blockTag: this.config.finalityTag });
    return bal.toString();
  }

  /** Cursor format: `<block>:<logIndex>`; only logs at or below the finality tag are returned. */
  async readEvents(_cursor: string | null, _limit: number): Promise<{ events: DomainEvent[]; nextCursor: string | null }> {
    if (!this.abis) return this.notReady('readEvents');
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

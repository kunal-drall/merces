import type { Pool } from 'pg';
import type { ChainPort } from '@merces/domain';
import { EVM_KNOWN, EvmChain, type EvmChainConfig } from '@merces/chain-evm';
import { SOLANA_KNOWN, SolanaChain, type SolanaChainConfig } from '@merces/chain-solana';
import { PgSimPersistence, SimulatorChain } from '@merces/simulator';
import { locateStage1, stage1Path, type Stage1Location } from './manifest.ts';

export type ModeSetting = 'mock' | 'live' | 'auto';

export interface ChainsConfig {
  solana: { mode: ModeSetting; rpcUrl?: string };
  evm: { mode: ModeSetting; chainKey: string; chainId?: number; rpcUrl?: string };
  stage1Path?: string;
  /** when set, simulators persist to Postgres under keys sim:<chain> */
  pool?: Pool;
  persistKeyPrefix?: string;
  generatedDir?: string;
  log?: (msg: string) => void;
}

export interface ChainDecision {
  chain: string;
  requested: ModeSetting;
  chosen: 'mock' | 'live';
  reason: string;
}

export interface ChainRegistry {
  chains: Map<string, ChainPort>;
  decisions: ChainDecision[];
  stage1: Stage1Location | null;
  get(chain: string): ChainPort;
  byFamily(family: 'solana' | 'evm'): ChainPort;
  close(): Promise<void>;
}

export function solanaConfigFrom(loc: Stage1Location | null, over: { rpcUrl?: string; generatedDir?: string } = {}): SolanaChainConfig | null {
  const s = loc?.manifest.solana;
  if (!s || !s.programs || Object.keys(s.programs).length === 0) return null;
  const coins = loc!.manifest.stablecoins?.solana ?? {};
  return {
    chain: 'solana',
    cluster: (s.cluster as SolanaChainConfig['cluster']) ?? 'devnet',
    rpcUrl: over.rpcUrl ?? s.rpcUrl ?? SOLANA_KNOWN.devnetRpc,
    programs: s.programs,
    idlDir: stage1Path(loc!, s.idlDir),
    generatedDir: over.generatedDir ? `${over.generatedDir}/solana` : null,
    stablecoins: { USDC: coins.USDC ?? SOLANA_KNOWN.usdcDevnet, USDG: coins.USDG ?? SOLANA_KNOWN.usdgDevnet },
    startSlot: s.startSlot ?? 0,
    keeperPublicKey: null,
    allowlistManagerPublicKey: null,
  };
}

export function evmConfigFrom(loc: Stage1Location | null, chainKey: string, over: { rpcUrl?: string; chainId?: number; generatedDir?: string } = {}): EvmChainConfig | null {
  const entry = loc?.manifest.evm?.find((e) => e.chain === chainKey || e.chain.startsWith(chainKey) || (over.chainId !== undefined && e.chainId === over.chainId));
  if (!entry || !entry.contracts || Object.keys(entry.contracts).length === 0) return null;
  const coins = loc!.manifest.stablecoins?.[entry.chain] ?? loc!.manifest.stablecoins?.[chainKey] ?? {};
  return {
    chain: chainKey,
    network: entry.chain,
    chainId: over.chainId ?? entry.chainId,
    rpcUrl: over.rpcUrl ?? entry.rpcUrl ?? (entry.chainId === EVM_KNOWN.monadTestnetChainId ? EVM_KNOWN.monadTestnetRpc : ''),
    contracts: entry.contracts,
    abiDir: stage1Path(loc!, entry.abiDir),
    generatedDir: over.generatedDir ? `${over.generatedDir}/evm` : null,
    stablecoins: { USDC: coins.USDC ?? (entry.chainId === EVM_KNOWN.monadTestnetChainId ? EVM_KNOWN.usdcMonadTestnet : undefined) },
    startBlock: entry.startBlock ?? 0,
    finalityTag: 'finalized',
    keeperAddress: null,
    allowlistManagerAddress: null,
  };
}

/**
 * D4 mode selection. `auto` (default): use the live adapter only when a valid manifest entry exists for the
 * chain AND its health check passes; otherwise the simulator. Each chain decides independently.
 */
export async function createChains(cfg: ChainsConfig): Promise<ChainRegistry> {
  const log = cfg.log ?? ((m: string) => console.log(`[chains] ${m}`));
  const stage1 = locateStage1(cfg.stage1Path);
  const chains = new Map<string, ChainPort>();
  const decisions: ChainDecision[] = [];

  async function decide(chain: string, requested: ModeSetting, live: (() => ChainPort | null) | null, mock: () => Promise<ChainPort>): Promise<void> {
    let chosen: 'mock' | 'live';
    let reason: string;
    let port: ChainPort;
    const tryLive = async (): Promise<{ port: ChainPort; detail: string } | { error: string }> => {
      let l: ChainPort | null;
      try {
        l = live ? live() : null;
      } catch (e) {
        return { error: `config rejected: ${(e as Error).message}` };
      }
      if (!l) return { error: stage1 ? `no Stage 1 entry for ${chain} in ${stage1.path}` : 'Stage 1 not present (STAGE1_PATH unset or empty)' };
      const h = await l.health();
      if (!h.ok) return { error: `health check failed: ${h.detail}` };
      return { port: l, detail: h.detail };
    };
    if (requested === 'mock') {
      port = await mock();
      chosen = 'mock';
      reason = 'configured mock';
    } else {
      const r = await tryLive();
      if ('port' in r) {
        port = r.port;
        chosen = 'live';
        reason = r.detail;
      } else if (requested === 'live') {
        throw new Error(`${chain}: mode=live but the live adapter is unavailable: ${r.error}`);
      } else {
        port = await mock();
        chosen = 'mock';
        reason = `auto → simulator (${r.error})`;
      }
    }
    chains.set(chain, port);
    decisions.push({ chain, requested, chosen, reason });
    log(`${chain}: requested=${requested} chosen=${chosen} — ${reason}`);
  }

  const persistence = (key: string) => (cfg.pool ? new PgSimPersistence(cfg.pool, `${cfg.persistKeyPrefix ?? 'sim'}:${key}`) : undefined);

  await decide(
    'solana',
    cfg.solana.mode,
    () => {
      const c = solanaConfigFrom(stage1, { rpcUrl: cfg.solana.rpcUrl, generatedDir: cfg.generatedDir });
      return c ? new SolanaChain(c) : null;
    },
    () => SimulatorChain.create({ personality: 'solana', chainKey: 'solana', persistence: persistence('solana') }),
  );
  await decide(
    cfg.evm.chainKey,
    cfg.evm.mode,
    () => {
      const c = evmConfigFrom(stage1, cfg.evm.chainKey, { rpcUrl: cfg.evm.rpcUrl, chainId: cfg.evm.chainId, generatedDir: cfg.generatedDir });
      return c ? new EvmChain(c) : null;
    },
    () => SimulatorChain.create({ personality: 'monad', chainKey: cfg.evm.chainKey, persistence: persistence(cfg.evm.chainKey) }),
  );

  return {
    chains,
    decisions,
    stage1,
    get(chain) {
      const c = chains.get(chain);
      if (!c) throw new Error(`unknown chain ${chain}`);
      return c;
    },
    byFamily(family) {
      for (const c of chains.values()) if (c.family === family) return c;
      throw new Error(`no chain of family ${family}`);
    },
    async close() {
      /* adapters hold no sockets that need closing */
    },
  };
}

export function chainsConfigFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<ChainsConfig> = {}): ChainsConfig {
  const mode = (v: string | undefined): ModeSetting => (v === 'mock' || v === 'live' || v === 'auto' ? v : 'auto');
  return {
    solana: { mode: mode(env.MERCES_CHAIN_SOLANA_MODE), rpcUrl: env.SOLANA_RPC_URL },
    evm: { mode: mode(env.MERCES_CHAIN_EVM_MODE), chainKey: env.EVM_CHAIN_KEY ?? 'monad', chainId: env.EVM_CHAIN_ID ? Number(env.EVM_CHAIN_ID) : undefined, rpcUrl: env.EVM_RPC_URL },
    stage1Path: env.STAGE1_PATH,
    ...extra,
  };
}

import type { Pool } from 'pg';
import type { ChainPort } from '@merces/domain';
import { EVM_KNOWN, EvmChain, type EvmChainConfig } from '@merces/chain-evm';
import { SOLANA_KNOWN, SolanaChain, normalizeCluster, type SolanaChainConfig } from '@merces/chain-solana';
import { Groth16ReportVerifier, MOCK_PROOFS_WARNING, reportProofSystemFromEnv, type ReportProofSystem } from '@merces/ports';
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
  /**
   * 'own' (default) opens the simulator for chains that resolve to it. 'skip' leaves them out of this registry: a
   * persisted simulator has exactly one owning process (the API, which indexes and cranks it in-process), so the
   * standalone indexer and keeper processes handle live chains only.
   */
  simulators?: 'own' | 'skip';
  /**
   * The report proofs simulator chains accept (critique H3). Default `groth16-bn254`: a simulator verifies Stage 1
   * Groth16 proofs with the ports' `Groth16ReportVerifier` before its engine runs, and refuses mock proofs. `mock`
   * (`MERCES_PROOF_SYSTEM=mock`) also accepts mock proofs, which anyone can forge: it is honoured only when every
   * chain resolves to the simulator (a live chain makes `createChains` refuse to start) and logs a warning.
   */
  proofSystem?: ReportProofSystem;
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
    // an unknown cluster name is passed through unchanged so the adapter's guard refuses it
    cluster: s.cluster ? (normalizeCluster(s.cluster) ?? (s.cluster as SolanaChainConfig['cluster'])) : 'devnet',
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
  // exact name first, then the configured chain id, and only then a prefix ('monad' for 'monad-testnet'): a prefix
  // must never pick 'monad-testnet-v2' when 'monad-testnet' itself is listed
  const evm = loc?.manifest.evm ?? [];
  const entry = evm.find((e) => e.chain === chainKey) ?? evm.find((e) => over.chainId !== undefined && e.chainId === over.chainId) ?? evm.find((e) => e.chain.startsWith(chainKey));
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
 * chain, its health check passes AND the adapter is wired to the generated Stage 1 clients (`wired`); otherwise
 * the simulator, with the reason logged. `live` skips the wiring check (conformance drives unwired adapters on
 * purpose) but still fails loudly on a missing entry, a refused network or a failed health check. Each chain
 * decides independently.
 */
export async function createChains(cfg: ChainsConfig): Promise<ChainRegistry> {
  const log = cfg.log ?? ((m: string) => console.log(`[chains] ${m}`));
  const stage1 = locateStage1(cfg.stage1Path);
  const chains = new Map<string, ChainPort>();
  const decisions: ChainDecision[] = [];

  // a simulator is opened only once every chain has decided: whether it may accept mock proofs depends on all of them
  const opened: { chain: string; port: ChainPort | null; mock: (acceptMockProofs: boolean) => Promise<ChainPort> }[] = [];
  async function decide(chain: string, requested: ModeSetting, live: (() => ChainPort | null) | null, mock: (acceptMockProofs: boolean) => Promise<ChainPort>): Promise<void> {
    let chosen: 'mock' | 'live';
    let reason: string;
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
      if (requested === 'auto' && (l as { wired?: boolean }).wired !== true) return { error: `live adapter not wired to the Stage 1 clients yet (D6 step 4); health: ${h.detail}` };
      return { port: l, detail: h.detail };
    };
    let livePort: ChainPort | null = null;
    if (requested === 'mock') {
      chosen = 'mock';
      reason = 'configured mock';
    } else {
      const r = await tryLive();
      if ('port' in r) {
        livePort = r.port;
        chosen = 'live';
        reason = r.detail;
      } else if (requested === 'live') {
        throw new Error(`${chain}: mode=live but the live adapter is unavailable: ${r.error}`);
      } else {
        chosen = 'mock';
        reason = `auto → simulator (${r.error})`;
      }
    }
    if (chosen === 'mock' && cfg.simulators === 'skip') {
      reason = `${reason}; not opened here (the API process owns the simulator)`;
      decisions.push({ chain, requested, chosen, reason });
      log(`${chain}: requested=${requested} chosen=${chosen} — ${reason}`);
      return;
    }
    opened.push({ chain, port: livePort, mock });
    decisions.push({ chain, requested, chosen, reason });
    log(`${chain}: requested=${requested} chosen=${chosen} — ${reason}`);
  }

  const persistence = (key: string) => (cfg.pool ? new PgSimPersistence(cfg.pool, `${cfg.persistKeyPrefix ?? 'sim'}:${key}`) : undefined);
  // one verifier (and verdict cache) for every simulator in the process
  const reportProofVerifier = new Groth16ReportVerifier();

  await decide(
    'solana',
    cfg.solana.mode,
    () => {
      const c = solanaConfigFrom(stage1, { rpcUrl: cfg.solana.rpcUrl, generatedDir: cfg.generatedDir });
      return c ? new SolanaChain(c) : null;
    },
    (acceptMockProofs) => SimulatorChain.create({ personality: 'solana', chainKey: 'solana', persistence: persistence('solana'), reportProofVerifier, acceptMockProofs }),
  );
  await decide(
    cfg.evm.chainKey,
    cfg.evm.mode,
    () => {
      const c = evmConfigFrom(stage1, cfg.evm.chainKey, { rpcUrl: cfg.evm.rpcUrl, chainId: cfg.evm.chainId, generatedDir: cfg.generatedDir });
      return c ? new EvmChain(c) : null;
    },
    (acceptMockProofs) => SimulatorChain.create({ personality: 'monad', chainKey: cfg.evm.chainKey, persistence: persistence(cfg.evm.chainKey), reportProofVerifier, acceptMockProofs }),
  );

  // H3: mock report proofs only in a process whose every chain is the simulator, and never silently
  const simulatorOnly = decisions.every((d) => d.chosen === 'mock');
  if (cfg.proofSystem === 'mock' && !simulatorOnly) throw new Error('MERCES_PROOF_SYSTEM=mock is refused: mock report proofs are forgeable, and this process has a live chain');
  const acceptMockProofs = cfg.proofSystem === 'mock';
  if (acceptMockProofs && opened.some((o) => !o.port)) log(`WARNING ${MOCK_PROOFS_WARNING}`);
  for (const o of opened) chains.set(o.chain, o.port ?? (await o.mock(acceptMockProofs)));

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
      // live adapters hold no sockets; a persisted simulator releases its single-writer lock
      for (const c of chains.values()) await (c as { close?: () => Promise<void> }).close?.();
    },
  };
}

export function chainsConfigFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<ChainsConfig> = {}): ChainsConfig {
  const mode = (v: string | undefined): ModeSetting => (v === 'mock' || v === 'live' || v === 'auto' ? v : 'auto');
  return {
    solana: { mode: mode(env.MERCES_CHAIN_SOLANA_MODE), rpcUrl: env.SOLANA_RPC_URL },
    evm: { mode: mode(env.MERCES_CHAIN_EVM_MODE), chainKey: env.EVM_CHAIN_KEY ?? 'monad', chainId: env.EVM_CHAIN_ID ? Number(env.EVM_CHAIN_ID) : undefined, rpcUrl: env.EVM_RPC_URL },
    stage1Path: env.STAGE1_PATH,
    persistKeyPrefix: env.MERCES_SIM_KEY,
    // validated against the decided chains in createChains (mock needs a simulator-only process)
    proofSystem: reportProofSystemFromEnv(env, { simulatorOnly: true }),
    ...extra,
  };
}

/** A view of a registry restricted to some of its chains (for example the simulated ones a process owns). */
export function subsetRegistry(reg: ChainRegistry, keep: (c: ChainPort) => boolean): ChainRegistry {
  const chains = new Map([...reg.chains].filter(([, c]) => keep(c)));
  return {
    chains,
    decisions: reg.decisions.filter((d) => chains.has(d.chain)),
    stage1: reg.stage1,
    get(chain) {
      const c = chains.get(chain);
      if (!c) throw new Error(`unknown chain ${chain}`);
      return c;
    },
    byFamily(family) {
      for (const c of chains.values()) if (c.family === family) return c;
      throw new Error(`no chain of family ${family}`);
    },
    close: () => reg.close(),
  };
}

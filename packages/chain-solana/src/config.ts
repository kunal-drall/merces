import type {WalletSigner,ServiceRole} from '@merces/domain';
export interface SolanaChainConfig {
  /** Pre-created, issuer-owned Stage 1 compatible DBC pools awaiting activation. */
  curvePools?:Record<string,string>;
  fxCurrencies?:Record<string,string>;
  /** Verified Pyth PriceUpdateV2 accounts by feed id. A price pusher maintains both primary and cross-check feeds. */
  priceUpdateAccounts?:Record<string,string>;
  serviceSigners?:Partial<Record<ServiceRole,WalletSigner>>;
  /** chain key used in ids; "solana" */
  chain: string;
  cluster: 'devnet' | 'testnet' | 'localnet';
  rpcUrl: string;
  /** Stage 1 program ids by module (from the handoff manifest) */
  programs: Record<string, string>;
  /** directory holding the Anchor IDLs (manifest.solana.idlDir) */
  idlDir: string | null;
  /** directory of generated clients (written by stage1:sync) */
  generatedDir: string | null;
  stablecoins: Partial<Record<'USDC' | 'USDG', string>>;
  /** slot to start indexing from */
  startSlot: number;
  /** service keys are resolved through the KMS port; this is only the public key */
  keeperPublicKey: string | null;
  allowlistManagerPublicKey: string | null;
}

/** Facts verified from official sources on 2026-10-07 (see VERSIONS.md / research notes). */
export const SOLANA_KNOWN = {
  devnetRpc: 'https://api.devnet.solana.com',
  /** Circle USDC devnet mint */
  usdcDevnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  /** Paxos USDG devnet mint */
  usdgDevnet: '4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7',
  /** mainnet mints are listed only so the guard can refuse them */
  usdcMainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdgMainnet: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  pythReceiverProgram: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
  pythPriceFeedProgram: 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT',
  meteoraDbcProgram: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
} as const;

/**
 * Cluster genesis hashes, from the official Solana cluster docs (solana-labs/solana docs/src/clusters/available.md,
 * the `--expected-genesis-hash` value for each cluster). The RPC URL says nothing reliable about which cluster it
 * serves; the genesis hash does.
 */
export const SOLANA_GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  /** listed only so the guard can name the refusal */
  mainnetBeta: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

const ALLOWED_CLUSTERS = ['devnet', 'testnet', 'localnet'] as const;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function normalizeCluster(cluster: string): SolanaChainConfig['cluster'] | null {
  const c = String(cluster).trim().toLowerCase();
  return (ALLOWED_CLUSTERS as readonly string[]).includes(c) ? (c as SolanaChainConfig['cluster']) : null;
}

/**
 * Static half of the mainnet guard (runs at construction). Fails closed: only devnet, testnet and localnet are
 * accepted, and localnet only on a loopback RPC (a local validator has its own random genesis, so the URL is the
 * only thing that can pin it). The genesis-hash half runs against the RPC in `checkGenesis`.
 */
export function assertNotMainnet(cfg: SolanaChainConfig): void {
  const refuse = (why: string) => {
    throw new Error(`Merces Stage 2 refuses this Solana configuration (ground rule: never touch mainnet): ${why}`);
  };
  const cluster = normalizeCluster(cfg.cluster);
  if (!cluster) refuse(`cluster '${String(cfg.cluster)}' is not one of ${ALLOWED_CLUSTERS.join(', ')}`);
  let url: URL;
  try {
    url = new URL(cfg.rpcUrl);
  } catch {
    return refuse(`rpcUrl is not a valid URL`);
  }
  if (url.href.toLowerCase().includes('mainnet')) refuse('rpcUrl names mainnet');
  if (cluster === 'localnet' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) refuse('localnet must use a loopback RPC');
  for (const m of Object.values(cfg.stablecoins)) {
    if (m === SOLANA_KNOWN.usdcMainnet || m === SOLANA_KNOWN.usdgMainnet) refuse('mainnet stablecoin mint in config');
  }
}

/**
 * Dynamic half of the mainnet guard: the RPC's genesis hash must be the configured cluster's. Returns the refusal
 * reason, or null when the hash is acceptable. The mainnet-beta hash is refused for every cluster, localnet included.
 */
export function checkGenesis(cluster: string, genesisHash: string): string | null {
  if (genesisHash === SOLANA_GENESIS.mainnetBeta) return 'refusing: RPC is Solana mainnet-beta (genesis hash)';
  const c = normalizeCluster(cluster);
  if (c === 'devnet' || c === 'testnet') {
    return genesisHash === SOLANA_GENESIS[c] ? null : `refusing: RPC genesis hash ${genesisHash} is not ${c}'s`;
  }
  if (c === 'localnet') {
    // a local validator must not be a public cluster under another name
    return genesisHash === SOLANA_GENESIS.devnet || genesisHash === SOLANA_GENESIS.testnet ? `refusing: localnet RPC serves a public cluster (genesis ${genesisHash})` : null;
  }
  return `refusing: cluster '${cluster}' is not allowed`;
}

export interface EvmChainConfig {
  /** chain key used in ids, e.g. "monad" */
  chain: string;
  /** human name, e.g. "monad-testnet" */
  network: string;
  chainId: number;
  rpcUrl: string;
  /** Stage 1 contract addresses by module */
  contracts: Record<string, string>;
  abiDir: string | null;
  generatedDir: string | null;
  stablecoins: Partial<Record<'USDC' | 'USDG', string>>;
  startBlock: number;
  /** block tag used for money-bearing reads and the event stream */
  finalityTag: 'finalized' | 'safe';
  keeperAddress: string | null;
  allowlistManagerAddress: string | null;
}

/** Facts verified from official sources on 2026-10-07 (see VERSIONS.md). */
export const EVM_KNOWN = {
  monadTestnetChainId: 10143,
  monadTestnetRpc: 'https://testnet-rpc.monad.xyz',
  monadMainnetChainId: 143,
  usdcMonadTestnet: '0x534b2f3a21130d7a60830c2df862319e593943a3',
  pythMonadTestnet: '0x2880ab155794e7179c9ee2e38200202908c17b43',
  /** Chainlink Data Feeds: no FX feeds listed on Monad (mainnet-only crypto feeds); cross-check is unavailable there */
  chainlinkFxOnMonad: null,
} as const;

/** Mainnet chain ids this backend refuses to connect to. */
const MAINNET_IDS = new Set([1, 10, 56, 137, 143, 8453, 42161, 43114]);

export function assertNotMainnet(cfg: EvmChainConfig): void {
  if (MAINNET_IDS.has(cfg.chainId) || /mainnet/i.test(cfg.network) || /mainnet/i.test(cfg.rpcUrl)) {
    throw new Error(`Merces Stage 2 refuses to connect to an EVM mainnet (chainId ${cfg.chainId})`);
  }
}

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

/**
 * EVM chain ids this backend may connect to. Fail closed: anything not listed is refused, so a new network needs
 * a deliberate code change here, and only testnets belong in it. Ids checked against ethereum-lists/chains
 * (_data/chains/eip155-<id>.json) on 2026-10-08.
 */
export const EVM_TESTNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [10143, 'Monad Testnet'],
  [11155111, 'Ethereum Sepolia'],
  [84532, 'Base Sepolia'],
  [421614, 'Arbitrum Sepolia'],
  [11155420, 'OP Sepolia'],
]);

/** Known mainnet ids, kept as a tripwire so a mainnet can never be added to the allow-list by mistake. */
const KNOWN_MAINNET_IDS = new Set([1, 10, 56, 100, 137, 143, 324, 8453, 42161, 42170, 43114, 59144, 81457, 534352]);
for (const id of EVM_TESTNET_CHAIN_IDS.keys()) if (KNOWN_MAINNET_IDS.has(id)) throw new Error(`EVM allow-list contains mainnet chain id ${id}`);

export function assertNotMainnet(cfg: EvmChainConfig): void {
  if (!EVM_TESTNET_CHAIN_IDS.has(cfg.chainId)) {
    throw new Error(`Merces Stage 2 only connects to allow-listed EVM testnets; chainId ${cfg.chainId} is not one (ground rule: never touch mainnet)`);
  }
  if (/mainnet/i.test(cfg.network) || /mainnet/i.test(cfg.rpcUrl)) {
    throw new Error(`Merces Stage 2 refuses to connect to an EVM mainnet (network ${cfg.network}, chainId ${cfg.chainId})`);
  }
}

import { EVM_TESTNET_CHAIN_IDS } from '@merces/domain';

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
 * Refuses an EVM chain off the testnet allow-list, or one whose name or RPC says mainnet. The allow-list
 * (`EVM_TESTNET_CHAIN_IDS`) and its mainnet tripwire live in `@merces/domain` (signing.ts) since S4 (D6), seeded from
 * Stage 1's own constants, so this connection guard and every signer read one list; the tripwire runs when that module
 * loads. Local dev chains (31337) are allowed for signing only (`assertSigningNetwork` with `allowLocal`), never here.
 */
export function assertNotMainnet(cfg: EvmChainConfig): void {
  if (!EVM_TESTNET_CHAIN_IDS.has(cfg.chainId)) {
    throw new Error(`Merces Stage 2 only connects to allow-listed EVM testnets; chainId ${cfg.chainId} is not one (ground rule: never touch mainnet)`);
  }
  if (/mainnet/i.test(cfg.network) || /mainnet/i.test(cfg.rpcUrl)) {
    throw new Error(`Merces Stage 2 refuses to connect to an EVM mainnet (network ${cfg.network}, chainId ${cfg.chainId})`);
  }
}

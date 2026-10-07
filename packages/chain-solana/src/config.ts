export interface SolanaChainConfig {
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

export function assertNotMainnet(cfg: SolanaChainConfig): void {
  const url = cfg.rpcUrl.toLowerCase();
  if (url.includes('mainnet') || (cfg.cluster as string) === 'mainnet-beta' || (cfg.cluster as string) === 'mainnet') {
    throw new Error('Merces Stage 2 refuses to connect to Solana mainnet (ground rule: never touch mainnet)');
  }
  for (const m of Object.values(cfg.stablecoins)) {
    if (m === SOLANA_KNOWN.usdcMainnet || m === SOLANA_KNOWN.usdgMainnet) throw new Error('mainnet stablecoin mint in config; refusing');
  }
}

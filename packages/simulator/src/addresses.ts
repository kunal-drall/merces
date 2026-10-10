import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import type { ChainFamily, ChainLimits } from '@merces/domain';

export type Personality = 'solana' | 'monad';

export function familyOf(p: Personality): ChainFamily {
  return p === 'solana' ? 'solana' : 'evm';
}

/** Deterministic, personality-correct addresses from a label. */
export function deriveAddress(family: ChainFamily, label: string): string {
  const h = sha256(utf8ToBytes(`merces-sim:${family}:${label}`));
  return family === 'solana' ? bs58.encode(h) : '0x' + bytesToHex(h.slice(0, 20));
}

export interface PersonalityConfig {
  personality: Personality;
  chain: string;
  family: ChainFamily;
  network: string;
  stablecoins: Partial<Record<'USDC' | 'USDG', { mint: string; decimals: number }>>;
}

export function personalityConfig(p: Personality, chainKey?: string): PersonalityConfig {
  const family = familyOf(p);
  const chain = chainKey ?? p;
  if (p === 'solana') {
    return {
      personality: p,
      chain,
      family,
      network: 'simulator-solana',
      stablecoins: {
        USDC: { mint: deriveAddress(family, 'mint:USDC'), decimals: 6 },
        USDG: { mint: deriveAddress(family, 'mint:USDG'), decimals: 6 },
      },
    };
  }
  return {
    personality: p,
    chain,
    family,
    network: 'simulator-monad',
    stablecoins: { USDC: { mint: deriveAddress(family, 'mint:USDC'), decimals: 6 } },
  };
}

/**
 * The settlement limits a personality mirrors (`ChainInfo.limits`): Solana tallies at most 24 bids per page (Stage 1
 * `TALLY_PAGE`, state.rs) with no bid limit; EVM at most 200 per page and 4,096 bids per auction (MercesConstants.sol).
 * Derived from the personality on every read, never persisted with the chain state.
 */
export function personalityLimits(p: Personality): ChainLimits {
  return p === 'solana' ? { tallyPageMax: 24, maxBidsPerAuction: null } : { tallyPageMax: 200, maxBidsPerAuction: 4096 };
}

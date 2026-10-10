import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import { EVM_LOCAL_CHAIN_ID, SOLANA_LOCAL_TAG, signingDomain, type ChainFamily, type ChainLimits, type SigningDomain } from '@merces/domain';

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

/**
 * The simulator's stand-in for Stage 1's registry: the program id (`merces_registry`) on the solana personality, the
 * `MercesRegistry` contract on monad. One per chain key, so two simulator chains of one personality never share a
 * signing domain.
 */
export function personalityRegistry(p: Personality, chainKey: string): { module: string; address: string } {
  return p === 'solana'
    ? { module: 'merces_registry', address: deriveAddress('solana', `program:merces_registry:${chainKey}`) }
    : { module: 'MercesRegistry', address: deriveAddress('evm', `contract:MercesRegistry:${chainKey}`) };
}

/**
 * The signing domain a personality's chain signs under (`ChainInfo.signing`, Stage 1 SPEC §1.3; S4 D6), from Stage 1's
 * local ids, which signers accept only with `allowLocal`: Solana's localnet cluster tag 104 (Stage 1
 * `SOLANA_CLUSTER_TAGS.localnet`, the LiteSVM harness's) with the registry program id's 32 bytes, or the local EVM
 * chain id 31337 with the `MercesRegistry` address left-padded. The registry is derived from the chain key
 * (`personalityRegistry`), so no simulator signature is valid on a real deployment or on another simulator chain.
 * Derived on every read, never persisted with the chain state, as `personalityLimits` is.
 */
export function personalitySigning(p: Personality, chainKey: string): SigningDomain {
  const family = familyOf(p);
  return signingDomain(family, family === 'solana' ? SOLANA_LOCAL_TAG : EVM_LOCAL_CHAIN_ID, personalityRegistry(p, chainKey).address);
}

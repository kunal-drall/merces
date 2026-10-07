import { z } from 'zod';
import bs58 from 'bs58';

/** Chain keys are configuration-defined. The two launch chains have fixed keys. */
export const CHAIN_SOLANA = 'solana';
export const CHAIN_MONAD = 'monad';
export type ChainKey = string;
export type ChainFamily = 'solana' | 'evm';
export type ChainMode = 'mock' | 'live';

export const chainFamilySchema = z.enum(['solana', 'evm']);
export const stablecoinSchema = z.enum(['USDC', 'USDG']);
export type Stablecoin = z.infer<typeof stablecoinSchema>;

/** A chain-local address. Solana: base58 of 32 bytes. EVM: 0x + 40 lowercase hex. */
export const addressSchema = z.string().min(1).max(64);
export type Address = string;

export function isSolanaAddress(a: string): boolean {
  try {
    return bs58.decode(a).length === 32;
  } catch {
    return false;
  }
}
export function isEvmAddress(a: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(a);
}
export function addressFamily(a: string): ChainFamily | null {
  if (isEvmAddress(a)) return 'evm';
  if (isSolanaAddress(a)) return 'solana';
  return null;
}
/** EVM addresses are normalised to lowercase in the domain (A-ID-1). Solana addresses are case-sensitive. */
export function normaliseAddress(a: string, family: ChainFamily): string {
  return family === 'evm' ? a.toLowerCase() : a;
}

/** seriesId = "<chain>:<address>" */
export const seriesIdSchema = z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/);
export type SeriesId = string;
export function makeSeriesId(chain: ChainKey, address: Address): SeriesId {
  return `${chain}:${address}`;
}
export function parseSeriesId(id: SeriesId): { chain: ChainKey; address: Address } {
  const i = id.indexOf(':');
  if (i <= 0) throw new Error(`bad seriesId: ${id}`);
  return { chain: id.slice(0, i), address: id.slice(i + 1) };
}

/** Period ids are calendar quarters: "2026Q3". */
export const periodIdSchema = z.string().regex(/^\d{4}Q[1-4]$/);
/** Currency pairs for the rate accumulator: "EUR/USD". */
export const pairSchema = z.string().regex(/^[A-Z]{3}\/[A-Z]{3}$/);
/** Hex-encoded 32-byte hashes with 0x prefix. */
export const hash32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
export type Hash32 = string;

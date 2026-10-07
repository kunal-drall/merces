/**
 * keccak-based commitments and identifiers (SPEC §1.3).
 */
import { bytes32, concatBytes, u64, u8 } from "./bytes.js";
import { keccak256 } from "./hash.js";

export enum ChainKind {
  Solana = 1,
  Evm = 2,
}

/** Solana cluster tags used as `chain_id` in the domain (SPEC §1.3). */
export const SOLANA_CLUSTER_TAGS = {
  mainnetBeta: 101n,
  testnet: 102n,
  devnet: 103n,
  localnet: 104n,
} as const;

/** EVM chain ids referenced by the spec. */
export const EVM_CHAIN_IDS = {
  monadMainnet: 143n,
  monadTestnet: 10143n,
} as const;

/**
 * Bid / ask commitment: `keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32)`.
 * Prices are base units per unit; quantities are units; `wallet` is the 32-byte wallet value.
 */
export function bidCommitment(price: bigint, quantity: bigint, salt: Uint8Array | string | bigint, wallet: Uint8Array): Uint8Array {
  if (wallet.length !== 32) throw new RangeError("wallet must be 32 bytes");
  return keccak256(u64(price), u64(quantity), bytes32(salt), wallet);
}

/** Bid commitment pre-image, for harnesses that want to hash it themselves. */
export function bidCommitmentPreimage(price: bigint, quantity: bigint, salt: Uint8Array | string | bigint, wallet: Uint8Array): Uint8Array {
  if (wallet.length !== 32) throw new RangeError("wallet must be 32 bytes");
  return concatBytes(u64(price), u64(quantity), bytes32(salt), wallet);
}

/**
 * Deployment domain: `keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_address_32)`.
 * `registryAddress` is the 32-byte wallet form of the registry (program id on Solana, padded
 * address on EVM).
 */
export function computeDomain(chainKind: ChainKind, chainId: bigint, registryAddress: Uint8Array): Uint8Array {
  if (chainKind !== ChainKind.Solana && chainKind !== ChainKind.Evm) throw new RangeError("unknown chain kind");
  if (registryAddress.length !== 32) throw new RangeError("registry address must be 32 bytes");
  return keccak256(u8(chainKind), u64(chainId), registryAddress);
}

/** EVM series key in signed messages: `bytes32(uint256(series_id))`. On Solana the series PDA is used as-is. */
export function seriesKeyFromId(seriesId: bigint): Uint8Array {
  return bytes32(seriesId);
}

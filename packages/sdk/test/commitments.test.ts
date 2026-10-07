import { describe, it, expect } from "vitest";
import {
  ChainKind,
  EVM_CHAIN_IDS,
  SOLANA_CLUSTER_TAGS,
  bidCommitment,
  bidCommitmentPreimage,
  bytes32,
  bytesToHex,
  computeDomain,
  concatBytes,
  hexToBytes,
  keccak256,
  seriesKeyFromId,
  u64,
  u8,
  walletFromEvmAddress,
  walletFromSolanaPubkey,
} from "../src/index.js";

describe("keccak256", () => {
  it("known answers", () => {
    expect(bytesToHex(keccak256(new Uint8Array(0)))).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(bytesToHex(keccak256(new TextEncoder().encode("abc")))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(keccak256(Uint8Array.of(1), Uint8Array.of(2))).toEqual(keccak256(Uint8Array.of(1, 2)));
  });
});

describe("bid commitment", () => {
  const salt = bytes32(0xabcdefn);
  const wallet = walletFromEvmAddress("0x" + "a1".repeat(20));
  it("is keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32)", () => {
    const preimage = bidCommitmentPreimage(1_000_000n, 100n, salt, wallet);
    expect(preimage.length).toBe(8 + 8 + 32 + 32);
    expect(preimage).toEqual(concatBytes(u64(1_000_000n), u64(100n), salt, wallet));
    expect(bidCommitment(1_000_000n, 100n, salt, wallet)).toEqual(keccak256(preimage));
  });
  it("differs per wallet, so each chain recomputes it with its own wallet bytes", () => {
    const sol = walletFromSolanaPubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(bidCommitment(1n, 1n, salt, sol)).not.toEqual(bidCommitment(1n, 1n, salt, wallet));
    expect(bidCommitment(1n, 1n, salt, wallet)).not.toEqual(bidCommitment(1n, 2n, salt, wallet));
    expect(bidCommitment(1n, 1n, salt, wallet)).not.toEqual(bidCommitment(2n, 1n, salt, wallet));
  });
  it("accepts salts as bigint, hex or bytes", () => {
    expect(bidCommitment(1n, 1n, 5n, wallet)).toEqual(bidCommitment(1n, 1n, bytes32(5n), wallet));
    expect(bidCommitment(1n, 1n, "0x" + "00".repeat(31) + "05", wallet)).toEqual(bidCommitment(1n, 1n, 5n, wallet));
    expect(() => bidCommitment(1n, 1n, salt, new Uint8Array(20))).toThrow(RangeError);
  });
});

describe("domain", () => {
  it("is keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_32)", () => {
    const registry = walletFromEvmAddress("0x" + "11".repeat(20));
    const d = computeDomain(ChainKind.Evm, EVM_CHAIN_IDS.monadTestnet, registry);
    expect(d).toEqual(keccak256(concatBytes(u8(2), u64(10143n), registry)));
    const s = computeDomain(ChainKind.Solana, SOLANA_CLUSTER_TAGS.devnet, hexToBytes("0x" + "22".repeat(32)));
    expect(s).toEqual(keccak256(concatBytes(u8(1), u64(103n), hexToBytes("0x" + "22".repeat(32)))));
    expect(d).not.toEqual(computeDomain(ChainKind.Evm, EVM_CHAIN_IDS.monadMainnet, registry));
    expect(() => computeDomain(3 as ChainKind, 1n, registry)).toThrow(RangeError);
  });
  it("constants", () => {
    expect(ChainKind.Solana).toBe(1);
    expect(ChainKind.Evm).toBe(2);
    expect(SOLANA_CLUSTER_TAGS).toEqual({ mainnetBeta: 101n, testnet: 102n, devnet: 103n, localnet: 104n });
    expect(EVM_CHAIN_IDS.monadTestnet).toBe(10143n);
  });
  it("EVM series key is bytes32(uint256(series_id))", () => {
    expect(bytesToHex(seriesKeyFromId(7n))).toBe("0x" + "00".repeat(31) + "07");
  });
});

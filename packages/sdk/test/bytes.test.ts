import { describe, it, expect } from "vitest";
import {
  base58Decode,
  base58Encode,
  bytes32,
  bytesToBigInt,
  bytesToHex,
  bytesToI64,
  concatBytes,
  evmAddressFromWallet,
  hexToBytes,
  i64,
  u16,
  u32,
  u64,
  u8,
  walletFromEvmAddress,
  walletFromSolanaPubkey,
  U64_MAX,
} from "../src/index.js";

describe("big-endian integer encodings", () => {
  it("encodes fixed widths", () => {
    expect(bytesToHex(u8(0))).toBe("0x00");
    expect(bytesToHex(u8(255))).toBe("0xff");
    expect(bytesToHex(u16(0x1234))).toBe("0x1234");
    expect(bytesToHex(u32(8104))).toBe("0x00001fa8");
    expect(bytesToHex(u64(1_000_000n))).toBe("0x00000000000f4240");
    expect(bytesToHex(u64(U64_MAX))).toBe("0xffffffffffffffff");
    expect(bytesToHex(i64(-1n))).toBe("0xffffffffffffffff");
    expect(bytesToHex(i64(-2_500_000_000n))).toBe("0xffffffff6afd0700");
    expect(bytesToHex(i64(2_500_000_000n))).toBe("0x000000009502f900");
    expect(bytesToI64(i64(-2_500_000_000n))).toBe(-2_500_000_000n);
    expect(bytesToI64(i64((1n << 63n) - 1n))).toBe((1n << 63n) - 1n);
    expect(bytesToI64(i64(-(1n << 63n)))).toBe(-(1n << 63n));
  });
  it("rejects out-of-range values", () => {
    expect(() => u8(256)).toThrow(RangeError);
    expect(() => u16(-1)).toThrow(RangeError);
    expect(() => u32(1n << 32n)).toThrow(RangeError);
    expect(() => u64(1n << 64n)).toThrow(RangeError);
    expect(() => u64(-1n)).toThrow(RangeError);
    expect(() => i64(1n << 63n)).toThrow(RangeError);
    expect(() => i64(-(1n << 63n) - 1n)).toThrow(RangeError);
    expect(() => u64(1.5)).toThrow();
  });
  it("bytes32 from bigint, hex and bytes", () => {
    expect(bytesToHex(bytes32(1n))).toBe("0x" + "00".repeat(31) + "01");
    expect(bytesToHex(bytes32("0x" + "ab".repeat(32)))).toBe("0x" + "ab".repeat(32));
    expect(() => bytes32("0x1234")).toThrow(RangeError);
    expect(() => bytes32(1n << 256n)).toThrow(RangeError);
    expect(bytesToBigInt(bytes32(123_456_789_012_345_678_901_234_567_890n))).toBe(123_456_789_012_345_678_901_234_567_890n);
  });
  it("hex helpers round-trip", () => {
    expect(hexToBytes("0x")).toEqual(new Uint8Array(0));
    expect(hexToBytes("abc")).toEqual(Uint8Array.of(0x0a, 0xbc));
    expect(() => hexToBytes("0xzz")).toThrow(TypeError);
    expect(bytesToHex(concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3)))).toBe("0x010203");
  });
});

describe("wallets", () => {
  it("Solana pubkeys are used as-is", () => {
    expect(bytesToHex(walletFromSolanaPubkey("11111111111111111111111111111111"))).toBe("0x" + "00".repeat(32));
    expect(bytesToHex(walletFromSolanaPubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))).toBe(
      "0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
    );
    expect(() => walletFromSolanaPubkey("abc")).toThrow(RangeError);
    expect(() => walletFromSolanaPubkey("0OIl")).toThrow(TypeError);
  });
  it("base58 round-trips", () => {
    const b = hexToBytes("0x0000ff01020304");
    expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
  it("EVM addresses are left-padded with 12 zero bytes", () => {
    const addr = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const w = walletFromEvmAddress(addr);
    expect(bytesToHex(w)).toBe("0x" + "00".repeat(12) + "7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(evmAddressFromWallet(w)).toBe(addr.toLowerCase());
    expect(() => walletFromEvmAddress("0x1234")).toThrow(RangeError);
    expect(() => evmAddressFromWallet(walletFromSolanaPubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))).toThrow(RangeError);
  });
});

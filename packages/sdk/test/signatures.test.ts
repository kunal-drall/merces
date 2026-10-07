import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  SECP256K1_HALF_N,
  SECP256K1_N,
  addressFromPrivateKey,
  addressFromPublicKey,
  bytes32,
  bytesToHex,
  concatBytes,
  deriveTestPrivateKey,
  hexToBytes,
  isLowS,
  keccak256,
  parseSignature,
  publicKeyFromPrivate,
  recoverAddress,
  signDigest,
  toChecksumAddress,
  verifySignature,
} from "../src/index.js";

const digest = keccak256(new TextEncoder().encode("merces"));

describe("secp256k1 attestor signatures (SPEC §1.4)", () => {
  it("derives Ethereum-style addresses (known answers for private keys 1 and 2)", () => {
    expect(toChecksumAddress(addressFromPrivateKey(bytes32(1n)))).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(toChecksumAddress(addressFromPrivateKey(bytes32(2n)))).toBe("0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF");
    const pub = publicKeyFromPrivate(bytes32(1n));
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(4);
    expect(addressFromPublicKey(pub)).toEqual(addressFromPublicKey(pub.slice(1)));
    expect(addressFromPublicKey(secp256k1.getPublicKey(bytes32(1n), true))).toEqual(addressFromPublicKey(pub));
  });

  it("signs with low-s and v in {27, 28}; recovers the signer", () => {
    for (const seed of ["attestor1", "attestor2", "verifier1", "x", "y", "z"]) {
      const key = deriveTestPrivateKey(seed);
      const sig = signDigest(digest, key);
      expect(sig.bytes.length).toBe(65);
      expect([27, 28]).toContain(sig.v);
      expect(sig.bytes[64]).toBe(sig.v);
      expect(isLowS(sig.s)).toBe(true);
      expect(sig.s <= SECP256K1_HALF_N).toBe(true);
      expect(bytesToHex(sig.bytes.slice(0, 32))).toBe(bytesToHex(bytes32(sig.r)));
      expect(bytesToHex(sig.bytes.slice(32, 64))).toBe(bytesToHex(bytes32(sig.s)));
      expect(recoverAddress(digest, sig.bytes)).toEqual(addressFromPrivateKey(key));
      expect(verifySignature(digest, sig.bytes, addressFromPrivateKey(key))).toBe(true);
      expect(verifySignature(digest, sig, bytesToHex(addressFromPrivateKey(key)))).toBe(true);
      // deterministic (RFC 6979)
      expect(signDigest(digest, key).bytes).toEqual(sig.bytes);
      // noble agrees
      expect(secp256k1.verify(sig.bytes.slice(0, 64), digest, publicKeyFromPrivate(key), { prehash: false, lowS: true })).toBe(true);
    }
  });

  it("rejects high-s, bad v and wrong lengths", () => {
    const key = deriveTestPrivateKey("attestor1");
    const sig = signDigest(digest, key);
    const highS = SECP256K1_N - sig.s;
    const flippedV = sig.v === 27 ? 28 : 27;
    const malleated = concatBytes(bytes32(sig.r), bytes32(highS), Uint8Array.of(flippedV));
    expect(() => parseSignature(malleated)).toThrow(/low-s/);
    expect(verifySignature(digest, malleated, addressFromPrivateKey(key))).toBe(false);
    const badV = concatBytes(bytes32(sig.r), bytes32(sig.s), Uint8Array.of(0));
    expect(() => parseSignature(badV)).toThrow(/invalid v/);
    const badV2 = concatBytes(bytes32(sig.r), bytes32(sig.s), Uint8Array.of(29));
    expect(() => parseSignature(badV2)).toThrow(/invalid v/);
    expect(() => parseSignature(sig.bytes.slice(0, 64))).toThrow(/65 bytes/);
    // wrong v recovers a different address
    const wrongV = concatBytes(bytes32(sig.r), bytes32(sig.s), Uint8Array.of(flippedV));
    expect(verifySignature(digest, wrongV, addressFromPrivateKey(key))).toBe(false);
    // other digest fails
    expect(verifySignature(keccak256(new Uint8Array(1)), sig.bytes, addressFromPrivateKey(key))).toBe(false);
    // other signer fails
    expect(verifySignature(digest, sig.bytes, addressFromPrivateKey(deriveTestPrivateKey("attestor2")))).toBe(false);
  });

  it("rejects non-32-byte digests and keys", () => {
    expect(() => signDigest(new Uint8Array(31), deriveTestPrivateKey("a"))).toThrow(RangeError);
    expect(() => signDigest(digest, new Uint8Array(31))).toThrow(RangeError);
    expect(() => recoverAddress(new Uint8Array(33), signDigest(digest, deriveTestPrivateKey("a")).bytes)).toThrow(RangeError);
    expect(() => verifySignature(digest, signDigest(digest, deriveTestPrivateKey("a")).bytes, new Uint8Array(19))).toThrow(RangeError);
  });

  it("test keys are deterministic and distinct", () => {
    expect(deriveTestPrivateKey("attestor1")).toEqual(deriveTestPrivateKey("attestor1"));
    expect(deriveTestPrivateKey("attestor1")).not.toEqual(deriveTestPrivateKey("attestor2"));
    const k = deriveTestPrivateKey("attestor1");
    const kv = BigInt(bytesToHex(k));
    expect(kv >= 1n && kv < SECP256K1_N).toBe(true);
  });

  it("EIP-55 checksum", () => {
    expect(toChecksumAddress(hexToBytes("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"))).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359")).toBe("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
  });
});

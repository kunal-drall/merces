import { describe, it, expect } from "vitest";
import {
  MAGIC,
  amendmentMessage,
  bytes32,
  bytesToHex,
  concatBytes,
  extinguishMessage,
  fxFallbackMessage,
  i64,
  keccak256,
  pauseApprovalMessage,
  reportAttestationMessage,
  trueUpMessage,
  u16,
  u32,
  u64,
  u8,
  utf8,
} from "../src/index.js";

const domain = bytes32(0xd0n);
const seriesKey = bytes32(0x5en);
const commitment = bytes32(0xc0n);

describe("signed message encodings (SPEC §1.4)", () => {
  it("exports the magic strings", () => {
    expect(MAGIC).toEqual({
      REPORT: "MERCES_REPORT_V1",
      FX: "MERCES_FX_V1",
      AMEND: "MERCES_AMEND_V1",
      PAUSE: "MERCES_PAUSE_V1",
      EXTINGUISH: "MERCES_EXTINGUISH_V1",
      TRUEUP: "MERCES_TRUEUP_V1",
    });
  });

  it("report attestation: magic ‖ domain ‖ series_key ‖ period_u32 ‖ prior_income_commitment_32 ‖ income_commitment_32 ‖ tier_u8 ‖ liquidity_event_u8", () => {
    const prior = bytes32(0xb0n);
    const m = reportAttestationMessage({ domain, seriesKey, period: 8104, priorIncomeCommitment: prior, incomeCommitment: commitment, tier: 2, liquidityEvent: false });
    const expected = concatBytes(utf8("MERCES_REPORT_V1"), domain, seriesKey, u32(8104), prior, commitment, u8(2), u8(0));
    expect(m.preimage).toEqual(expected);
    expect(m.preimage.length).toBe(16 + 32 + 32 + 4 + 32 + 32 + 1 + 1);
    expect(m.digest).toEqual(keccak256(expected));
    expect(m.kind).toBe("REPORT");
    // bigint commitments are encoded big-endian, same as bytes
    expect(reportAttestationMessage({ domain, seriesKey, period: 8104, priorIncomeCommitment: 0xb0n, incomeCommitment: 0xc0n, tier: 2, liquidityEvent: false }).digest).toEqual(m.digest);
    expect(reportAttestationMessage({ domain, seriesKey, period: 8104, priorIncomeCommitment: prior, incomeCommitment: commitment, tier: 3, liquidityEvent: false }).digest).not.toEqual(m.digest);
    const liq = reportAttestationMessage({ domain, seriesKey, period: 8104, priorIncomeCommitment: prior, incomeCommitment: commitment, tier: 2, liquidityEvent: true });
    expect(liq.preimage[liq.preimage.length - 1]).toBe(1);
    expect(liq.digest).not.toEqual(m.digest);
    // the prior commitment is bound: a different prior gives a different digest
    expect(reportAttestationMessage({ domain, seriesKey, period: 8104, priorIncomeCommitment: bytes32(0xb1n), incomeCommitment: commitment, tier: 2, liquidityEvent: false }).digest).not.toEqual(m.digest);
  });

  it("fx fallback: magic ‖ domain ‖ series_key ‖ period_u32 ‖ fx_rate_wad_u64", () => {
    const m = fxFallbackMessage({ domain, seriesKey, period: 8105, fxRateWad: 1_083_000_000_000_000_000n });
    expect(m.preimage).toEqual(concatBytes(utf8("MERCES_FX_V1"), domain, seriesKey, u32(8105), u64(1_083_000_000_000_000_000n)));
    expect(m.preimage.length).toBe(12 + 32 + 32 + 4 + 8);
  });

  it("amendment: magic ‖ domain ‖ series_key ‖ nonce_u64 ‖ new_terms_32 ‖ new_cap_u64", () => {
    const m = amendmentMessage({ domain, seriesKey, amendmentNonce: 3n, newTermsCommitment: commitment, newCapMultipleWad: 2_400_000_000_000_000_000n });
    expect(m.preimage).toEqual(concatBytes(utf8("MERCES_AMEND_V1"), domain, seriesKey, u64(3n), commitment, u64(2_400_000_000_000_000_000n)));
    expect(m.preimage.length).toBe(15 + 32 + 32 + 8 + 32 + 8);
  });

  it("pause approval: magic ‖ domain ‖ series_key ‖ pause_nonce_u64 ‖ pause_end_u64", () => {
    const m = pauseApprovalMessage({ domain, seriesKey, pauseNonce: 0n, pauseEnd: 1_783_209_600n });
    expect(m.preimage).toEqual(concatBytes(utf8("MERCES_PAUSE_V1"), domain, seriesKey, u64(0n), u64(1_783_209_600n)));
    expect(m.preimage.length).toBe(15 + 32 + 32 + 8 + 8);
  });

  it("extinguishment: magic ‖ domain ‖ series_key ‖ extinguish_nonce_u64", () => {
    const m = extinguishMessage({ domain, seriesKey, extinguishNonce: 1n });
    expect(m.preimage).toEqual(concatBytes(utf8("MERCES_EXTINGUISH_V1"), domain, seriesKey, u64(1n)));
    expect(m.preimage.length).toBe(20 + 32 + 32 + 8);
  });

  it("true-up: magic ‖ domain ‖ series_key ‖ trueup_nonce_u64 ‖ year_u16 ‖ adjustment_i64 ‖ attestation_ts_u64", () => {
    const m = trueUpMessage({ domain, seriesKey, trueupNonce: 3n, year: 2026, adjustment: -2_500_000_000n, attestationTs: 1_799_000_000n });
    expect(m.preimage).toEqual(concatBytes(utf8("MERCES_TRUEUP_V1"), domain, seriesKey, u64(3n), u16(2026), i64(-2_500_000_000n), u64(1_799_000_000n)));
    expect(m.preimage.length).toBe(16 + 32 + 32 + 8 + 2 + 8 + 8);
    expect(bytesToHex(m.preimage.slice(16 + 64 + 8 + 2, 16 + 64 + 8 + 10))).toBe("0xffffffff6afd0700");
    expect(trueUpMessage({ domain, seriesKey, trueupNonce: 4n, year: 2026, adjustment: -2_500_000_000n, attestationTs: 1_799_000_000n }).digest).not.toEqual(m.digest);
  });

  it("different domains or series give different digests", () => {
    const base = { priorIncomeCommitment: bytes32(0xb0n), incomeCommitment: commitment, tier: 2, liquidityEvent: false };
    const a = reportAttestationMessage({ domain, seriesKey, period: 1, ...base });
    const b = reportAttestationMessage({ domain: bytes32(0xd1n), seriesKey, period: 1, ...base });
    const c = reportAttestationMessage({ domain, seriesKey: bytes32(0x5fn), period: 1, ...base });
    expect(a.digest).not.toEqual(b.digest);
    expect(a.digest).not.toEqual(c.digest);
  });

  it("rejects malformed fields", () => {
    const base = { priorIncomeCommitment: bytes32(0xb0n), incomeCommitment: commitment, tier: 2, liquidityEvent: false };
    expect(() => reportAttestationMessage({ domain: new Uint8Array(31), seriesKey, period: 1, ...base })).toThrow(RangeError);
    expect(() => reportAttestationMessage({ domain, seriesKey, period: 1n << 32n, ...base })).toThrow(RangeError);
    expect(() => reportAttestationMessage({ domain, seriesKey, period: 1, ...base, tier: 256 })).toThrow(RangeError);
    expect(() => trueUpMessage({ domain, seriesKey, trueupNonce: 0n, year: 70000, adjustment: 0n, attestationTs: 0n })).toThrow(RangeError);
  });
});

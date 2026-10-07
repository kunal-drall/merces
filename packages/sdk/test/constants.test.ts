import { describe, it, expect } from "vitest";
import {
  DEFAULT_PARAMETERS,
  DEFAULT_PROTOCOL_FLAGS,
  ERRORS,
  ERROR_NAMES,
  PARAMETER_BOUNDS,
  PARAMETER_NAMES,
  RaiseState,
  SeriesStatus,
  TIER_FLAG,
  Tier,
  WAD,
  isErrorName,
  parametersFromStrings,
  parametersToStrings,
  tierEnabled,
  tierFlagOf,
  validateParameters,
} from "../src/index.js";

describe("parameters (SPEC §1.6)", () => {
  it("defaults", () => {
    expect(DEFAULT_PARAMETERS.capMultipleWad).toBe(2_500_000_000_000_000_000n);
    expect(DEFAULT_PARAMETERS.hurdleRateWad).toBe(80_000_000_000_000_000n);
    expect(DEFAULT_PARAMETERS.payoutMultipleK).toBe(5);
    expect(DEFAULT_PARAMETERS.lockupSeconds).toBe(47_336_400n);
    expect(DEFAULT_PARAMETERS.walletCapBps).toBe(1000);
    expect(DEFAULT_PARAMETERS.auctionFeeBps).toBe(100);
    expect(DEFAULT_PARAMETERS.payoutFeeBps).toBe(500);
    expect(DEFAULT_PARAMETERS.windowFeeBps).toBe(100);
    expect(DEFAULT_PARAMETERS.nonRevealChargeBps).toBe(100);
    expect(DEFAULT_PARAMETERS.commitDuration).toBe(7n * 86_400n);
    expect(DEFAULT_PARAMETERS.revealDuration).toBe(2n * 86_400n);
    expect(DEFAULT_PARAMETERS.windowCommitDuration).toBe(3n * 86_400n);
    expect(DEFAULT_PARAMETERS.windowRevealDuration).toBe(86_400n);
    expect(DEFAULT_PARAMETERS.reportDueDays).toBe(30);
    expect(DEFAULT_PARAMETERS.graceDays).toBe(15);
    expect(DEFAULT_PARAMETERS.formalNoticeDays).toBe(90);
    expect(DEFAULT_PARAMETERS.trueupDays).toBe(60);
    expect(DEFAULT_PARAMETERS.tailSeconds).toBe(31_536_000n);
    expect(DEFAULT_PARAMETERS.fxMinCoverageBps).toBe(8000);
    expect(DEFAULT_PARAMETERS.fxMaxStalenessSeconds).toBe(3600n);
    expect(DEFAULT_PARAMETERS.fxMaxConfBps).toBe(100);
    expect(DEFAULT_PARAMETERS.fxDeviationBandBps).toBe(200);
    expect(DEFAULT_PARAMETERS.maxReleaseTranches).toBe(24);
    expect(PARAMETER_NAMES.length).toBe(23);
  });
  it("defaults sit inside the bounds; bounds match the spec table", () => {
    expect(validateParameters(DEFAULT_PARAMETERS)).toEqual([]);
    expect(PARAMETER_BOUNDS.capMultipleWad).toEqual({ min: 2n * WAD, max: 3n * WAD });
    expect(PARAMETER_BOUNDS.hurdleRateWad).toEqual({ min: 0n, max: WAD / 4n });
    expect(PARAMETER_BOUNDS.payoutMultipleK).toEqual({ min: 1n, max: 20n });
    expect(PARAMETER_BOUNDS.lockupSeconds).toEqual({ min: 0n, max: 157_680_000n });
    expect(PARAMETER_BOUNDS.walletCapBps).toEqual({ min: 100n, max: 10_000n });
    expect(PARAMETER_BOUNDS.auctionFeeBps).toEqual({ min: 0n, max: 1_000n });
    expect(PARAMETER_BOUNDS.payoutFeeBps).toEqual({ min: 0n, max: 2_000n });
    expect(PARAMETER_BOUNDS.commitDuration).toEqual({ min: 3600n, max: 30n * 86_400n });
    expect(PARAMETER_BOUNDS.revealDuration).toEqual({ min: 3600n, max: 7n * 86_400n });
    expect(PARAMETER_BOUNDS.windowCommitDuration).toEqual({ min: 3600n, max: 14n * 86_400n });
    expect(PARAMETER_BOUNDS.windowRevealDuration).toEqual({ min: 3600n, max: 7n * 86_400n });
    expect(PARAMETER_BOUNDS.fxMinCoverageBps).toEqual({ min: 5_000n, max: 10_000n });
    expect(PARAMETER_BOUNDS.fxMaxStalenessSeconds).toEqual({ min: 60n, max: 86_400n });
    expect(PARAMETER_BOUNDS.fxMaxConfBps).toEqual({ min: 1n, max: 1_000n });
    expect(PARAMETER_BOUNDS.fxDeviationBandBps).toEqual({ min: 10n, max: 5_000n });
  });
  it("validateParameters names the offending fields", () => {
    expect(validateParameters({ ...DEFAULT_PARAMETERS, capMultipleWad: 3n * WAD + 1n, walletCapBps: 99 })).toEqual(["capMultipleWad", "walletCapBps"]);
    expect(validateParameters({ ...DEFAULT_PARAMETERS, hurdleRateWad: 0n, payoutMultipleK: 20, lockupSeconds: 0n })).toEqual([]);
    expect(validateParameters({ ...DEFAULT_PARAMETERS, reportDueDays: 31 })).toEqual(["reportDueDays"]);
  });
  it("string form round-trips with snake_case keys", () => {
    const s = parametersToStrings(DEFAULT_PARAMETERS);
    expect(s["cap_multiple_wad"]).toBe("2500000000000000000");
    expect(s["payout_multiple_k"]).toBe("5");
    expect(s["fx_max_staleness_seconds"]).toBe("3600");
    expect(Object.keys(s).length).toBe(23);
    expect(parametersFromStrings(s)).toEqual(DEFAULT_PARAMETERS);
    expect(() => parametersFromStrings({})).toThrow(/missing parameter cap_multiple_wad/);
  });
  it("flags default to closed", () => {
    expect(DEFAULT_PROTOCOL_FLAGS).toEqual({ newRaisesPaused: false, windowsEnabled: false, tier4Enabled: false, earlyDrawApprover: null });
  });
});

describe("enums", () => {
  it("status and raise state codes", () => {
    expect(SeriesStatus.OnTime).toBe(0);
    expect(SeriesStatus.InGrace).toBe(1);
    expect(SeriesStatus.Late).toBe(2);
    expect(SeriesStatus.Paused).toBe(3);
    expect(SeriesStatus.Retired).toBe(4);
    expect(SeriesStatus.Redeemed).toBe(5);
    expect(SeriesStatus.Extinguished).toBe(6);
    expect(RaiseState.Draft).toBe(0);
    expect(RaiseState.Settled).toBe(4);
    expect(RaiseState.Cancelled).toBe(6);
  });
  it("tier flags", () => {
    expect(TIER_FLAG).toEqual({ tier1: 1, tier2: 2, tier3: 4, tier4: 8 });
    expect(tierFlagOf(Tier.Tier3Attestor)).toBe(4);
    expect(tierEnabled(0b0110, Tier.Tier2Zktls)).toBe(true);
    expect(tierEnabled(0b0110, Tier.Tier1Split)).toBe(false);
    expect(tierEnabled(0b1000, Tier.Tier4Self)).toBe(true);
  });
  it("error names are unique and include the SPEC-named ones", () => {
    expect(new Set(ERROR_NAMES).size).toBe(ERROR_NAMES.length);
    for (const n of ["DirectTransferForbidden", "InvalidClearingPrice", "NoUnitsOutstanding", "TransferFeeNotZero", "NoTailDue"]) {
      expect(isErrorName(n)).toBe(true);
      expect(ERRORS[n as keyof typeof ERRORS]).toBeTypeOf("string");
    }
    expect(isErrorName("Nope")).toBe(false);
  });
});

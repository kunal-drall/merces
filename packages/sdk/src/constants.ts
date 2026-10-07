/**
 * Parameters, bounds, defaults and enumerations (SPEC §1.6, §1.7).
 */
import { DAY, EIGHTEEN_MONTHS_SECONDS, YEAR } from "./periods.js";
import { WAD } from "./fixedpoint.js";

export interface Parameters {
  capMultipleWad: bigint;
  hurdleRateWad: bigint;
  payoutMultipleK: number;
  lockupSeconds: bigint;
  walletCapBps: number;
  auctionFeeBps: number;
  payoutFeeBps: number;
  windowFeeBps: number;
  nonRevealChargeBps: number;
  commitDuration: bigint;
  revealDuration: bigint;
  windowCommitDuration: bigint;
  windowRevealDuration: bigint;
  reportDueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  trueupDays: number;
  tailSeconds: bigint;
  fxMinCoverageBps: number;
  fxMaxStalenessSeconds: bigint;
  fxMaxConfBps: number;
  fxDeviationBandBps: number;
  maxReleaseTranches: number;
}

export const HOUR = 3_600n;

export const DEFAULT_PARAMETERS: Readonly<Parameters> = Object.freeze({
  capMultipleWad: (25n * WAD) / 10n,
  hurdleRateWad: (8n * WAD) / 100n,
  payoutMultipleK: 5,
  lockupSeconds: EIGHTEEN_MONTHS_SECONDS,
  walletCapBps: 1000,
  auctionFeeBps: 100,
  payoutFeeBps: 500,
  windowFeeBps: 100,
  nonRevealChargeBps: 100,
  commitDuration: 7n * DAY,
  revealDuration: 2n * DAY,
  windowCommitDuration: 3n * DAY,
  windowRevealDuration: 1n * DAY,
  reportDueDays: 30,
  graceDays: 15,
  formalNoticeDays: 90,
  trueupDays: 60,
  tailSeconds: YEAR,
  fxMinCoverageBps: 8000,
  fxMaxStalenessSeconds: HOUR,
  fxMaxConfBps: 100,
  fxDeviationBandBps: 200,
  maxReleaseTranches: 24,
});

export interface Bound {
  min: bigint;
  max: bigint;
}

/** Inclusive bounds enforced at series creation. Fixed-by-brief values have min == max. */
export const PARAMETER_BOUNDS: Readonly<Record<keyof Parameters, Bound>> = Object.freeze({
  capMultipleWad: { min: 2n * WAD, max: 3n * WAD },
  hurdleRateWad: { min: 0n, max: WAD / 4n },
  payoutMultipleK: { min: 1n, max: 20n },
  lockupSeconds: { min: 0n, max: 5n * YEAR },
  walletCapBps: { min: 100n, max: 10_000n },
  auctionFeeBps: { min: 0n, max: 1_000n },
  payoutFeeBps: { min: 0n, max: 2_000n },
  windowFeeBps: { min: 0n, max: 1_000n },
  nonRevealChargeBps: { min: 0n, max: 1_000n },
  commitDuration: { min: HOUR, max: 30n * DAY },
  revealDuration: { min: HOUR, max: 7n * DAY },
  windowCommitDuration: { min: HOUR, max: 14n * DAY },
  windowRevealDuration: { min: HOUR, max: 7n * DAY },
  reportDueDays: { min: 30n, max: 30n },
  graceDays: { min: 15n, max: 15n },
  formalNoticeDays: { min: 90n, max: 90n },
  trueupDays: { min: 60n, max: 60n },
  tailSeconds: { min: YEAR, max: YEAR },
  fxMinCoverageBps: { min: 5_000n, max: 10_000n },
  fxMaxStalenessSeconds: { min: 60n, max: DAY },
  fxMaxConfBps: { min: 1n, max: 1_000n },
  fxDeviationBandBps: { min: 10n, max: 5_000n },
  maxReleaseTranches: { min: 24n, max: 24n },
});

export const PARAMETER_NAMES = Object.keys(DEFAULT_PARAMETERS) as (keyof Parameters)[];

/** Returns the names of parameters outside their bounds (empty when valid). */
export function validateParameters(p: Parameters): (keyof Parameters)[] {
  const bad: (keyof Parameters)[] = [];
  for (const name of PARAMETER_NAMES) {
    const v = BigInt(p[name]);
    const b = PARAMETER_BOUNDS[name];
    if (v < b.min || v > b.max) bad.push(name);
  }
  return bad;
}

/** All parameters as decimal strings (the vector `config.parameters` form, snake_case keys). */
export function parametersToStrings(p: Parameters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PARAMETER_NAMES) out[snakeCase(name)] = BigInt(p[name]).toString();
  return out;
}

/** Inverse of {@link parametersToStrings}. */
export function parametersFromStrings(s: Record<string, string>): Parameters {
  const p: Record<string, bigint | number> = {};
  for (const name of PARAMETER_NAMES) {
    const raw = s[snakeCase(name)];
    if (raw === undefined) throw new Error(`missing parameter ${snakeCase(name)}`);
    const v = BigInt(raw);
    p[name] = typeof DEFAULT_PARAMETERS[name] === "number" ? Number(v) : v;
  }
  return p as unknown as Parameters;
}

export function snakeCase(name: string): string {
  return name.replace(/([A-Z])/g, (m) => "_" + m.toLowerCase());
}

export interface ProtocolFlags {
  newRaisesPaused: boolean;
  windowsEnabled: boolean;
  tier4Enabled: boolean;
  /** 32-byte wallet or null when unset (early draws off). */
  earlyDrawApprover: Uint8Array | null;
}

export const DEFAULT_PROTOCOL_FLAGS: Readonly<ProtocolFlags> = Object.freeze({
  newRaisesPaused: false,
  windowsEnabled: false,
  tier4Enabled: false,
  earlyDrawApprover: null,
});

export enum SeriesStatus {
  OnTime = 0,
  InGrace = 1,
  Late = 2,
  Paused = 3,
  Retired = 4,
  Redeemed = 5,
  Extinguished = 6,
}

export enum RaiseState {
  Draft = 0,
  Open = 1,
  Reveal = 2,
  Settling = 3,
  Settled = 4,
  Failed = 5,
  Cancelled = 6,
}

export enum SeriesMode {
  SealedBid = 0,
  Curve = 1,
}

export enum Tier {
  Tier1Split = 1,
  Tier2Zktls = 2,
  Tier3Attestor = 3,
  Tier4Self = 4,
}

/** `tier_flags` bits: bit0 tier1 split, bit1 tier2 zkTLS, bit2 tier3 attestor, bit3 tier4 self. */
export const TIER_FLAG = {
  tier1: 1,
  tier2: 2,
  tier3: 4,
  tier4: 8,
} as const;

export function tierFlagOf(tier: Tier): number {
  return 1 << (tier - 1);
}

export function tierEnabled(tierFlags: number, tier: Tier): boolean {
  return (tierFlags & tierFlagOf(tier)) !== 0;
}

export enum PayoutSource {
  Payment = 0,
  Router = 1,
  Tail = 2,
  Final = 3,
}

export enum OrderSide {
  Bid = 0,
  Ask = 1,
}

/** ISO-4217 numeric currency codes used in terms commitments. */
export const CURRENCY_CODES = {
  USD: 840,
  EUR: 978,
  GBP: 826,
  AUD: 36,
  CAD: 124,
  CHF: 756,
  JPY: 392,
  INR: 356,
  SGD: 702,
  BRL: 986,
  MXN: 484,
} as const;

/** `indexing_rule` codes. */
export const INDEXING_RULES = {
  none: 0,
  cpiYearly: 1,
} as const;

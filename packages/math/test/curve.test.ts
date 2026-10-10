import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURVE_BASE_DECIMALS,
  CURVE_UNIT_SCALE,
  DEFAULT_PARAMETERS,
  U64_MAX,
  WAD,
  YEAR,
  capEffWad,
  capPerUnit,
  capRemaining,
  capRemainingScaled,
  isCapped,
  isCappedScaled,
  migrationFeeSplit,
  newTailState,
  newVaultState,
  newYearGross,
  p0PerUnit,
  redemptionQuote,
  redemptionQuoteScaled,
  scaledAmount,
  scaledCapWad,
  settleHolderDelta,
  swapBaseMatchesOffer,
  tailReceive,
  tailReceiveScaled,
  unitScaleFor,
  unitsOutstanding,
  vaultReceiveGross,
  vaultReceiveGrossScaled,
  wadPerScaledUnit,
  walletTenderFits,
  yearGrossAdd,
  yearGrossGet,
  type RedemptionInputs,
  type TailState,
  type VaultState,
  type YearGrossRing,
} from '../src/index.ts';

/*
 * Cause S3-M: the curve and unit-scale family is ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3).
 * Three kinds of pin:
 *  - scale 1 is Stage 1: each scale-aware function deep-equals Stage 1's own TypeScript function on seeded grids;
 *  - every figure Stage 1's Rust tests and fixtures give is pinned, with its file and lines in the Stage 1 checkout
 *    (CM = solana/crates/merces-common/src, CMT = solana/tests/tests/curve_mode.rs,
 *    FX = solana/tests/fixtures/meteora/{curve_config,curve_reports}.json);
 *  - Stage 1's Rust properties are replayed on seeded loops, plus our own scale invariance of the vault and the tail
 *    (the same series accounted per whole unit and per base lamport), after CM properties.rs:165-205.
 * That none of these names is a Stage 1 object is pinned with the gateway's key list (math.test.ts).
 */

const S = CURVE_UNIT_SCALE;
const USDC = 1_000_000n;
const FIXTURES = new URL('../../../stage1/solana/tests/fixtures/meteora/', import.meta.url);
const curveConfig = JSON.parse(readFileSync(new URL('curve_config.json', FIXTURES), 'utf8')) as {
  expected: Record<string, string | number>;
  pdaCreator: { expected: Record<string, string | number> };
};
const curveReports = JSON.parse(readFileSync(new URL('curve_reports.json', FIXTURES), 'utf8')) as {
  fixtures: { name: string; units_outstanding: string; payment_usd: string }[];
};
const big = (v: string | number) => BigInt(v);

/** A seeded xorshift64 generator: the loops below are deterministic (no new dependency). */
function rng(seed: bigint) {
  const M = (1n << 64n) - 1n;
  let x = seed & M || 1n;
  const next64 = () => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return x;
  };
  /** Uniform enough in [lo, hi] (inclusive), for ranges up to 2^128. */
  const between = (lo: bigint, hi: bigint): bigint => lo + (((next64() << 64n) | next64()) % (hi - lo + 1n));
  return { between, int: (lo: number, hi: number) => Number(between(BigInt(lo), BigInt(hi))), pick: <T>(xs: readonly T[]) => xs[Number(between(0n, BigInt(xs.length - 1)))]! };
}
type Rng = ReturnType<typeof rng>;

function randomRing(r: Rng, scale: bigint): YearGrossRing {
  let ring = newYearGross();
  for (let i = r.int(0, 4); i > 0; i--) ring = yearGrossAdd(ring, r.int(0, 8), r.between(0n, 10n ** 12n) * scale);
  return ring;
}

/** A vault state whose accumulators are multiples of `scale` (so `/ scale` is the same state per base lamport). */
function randomVault(r: Rng, N: bigint, cap: bigint, scale: bigint): VaultState {
  const capWad = cap * WAD;
  const paid = r.pick(['zero', 'below', 'at', 'above'] as const);
  const paidPerUnitWad =
    paid === 'zero' ? 0n : paid === 'below' ? r.between(0n, capWad / scale) * scale : paid === 'at' ? capWad : capWad + r.between(1n, 10n ** 6n) * scale;
  return {
    ...newVaultState(),
    paidPerUnitWad,
    netAccWad: r.between(0n, 10n ** 30n),
    carryWad: r.between(0n, N - 1n),
    grossReceived: r.between(0n, 10n ** 15n),
    feeCollected: r.between(0n, 10n ** 12n),
    refundedToIssuer: r.between(0n, 10n ** 12n),
    retired: r.int(0, 9) === 0,
    yearGross: randomRing(r, scale),
  };
}

function randomTail(r: Rng, N: bigint, scale: bigint): TailState {
  const tailCapPerUnit = r.pick([0n, r.between(1n, 10n ** 9n)]);
  const capWad = tailCapPerUnit * WAD;
  return {
    ...newTailState(tailCapPerUnit),
    tailPaidPerUnitWad: r.pick([0n, capWad, r.between(0n, capWad / scale) * scale]),
    tailAccWad: r.between(0n, 10n ** 30n),
    tailCarryWad: r.between(0n, N - 1n),
    tailExhausted: r.int(0, 9) === 0,
  };
}

/** Rust's `RedemptionPrice {price, hurdle, d_avg, cap_remaining}` from a quote (`d_avg` is 0 before a full year). */
const rustPrice = (q: ReturnType<typeof redemptionQuote>) => ({ price: q.pRedeem, hurdle: q.pHurdle, d_avg: q.dAvg ?? 0n, cap_remaining: q.cRemaining });

// ---------------------------------------------------------------- scale 1 is Stage 1

describe('at scale 1 every scale-aware function returns Stage 1\'s own result', () => {
  it('vaultReceiveGrossScaled ≡ vaultReceiveGross, isCappedScaled ≡ isCapped (2,000 seeded cases)', () => {
    const r = rng(0x5eed_0001n);
    for (let i = 0; i < 2_000; i++) {
      const N = r.pick([1n, 3n, r.between(1n, 10n ** 9n)]);
      const cap = r.between(0n, 10n ** 12n);
      const state = randomVault(r, N, cap, 1n);
      const G = r.pick([0n, 1n, r.between(0n, 10n ** 13n)]);
      const fee = r.int(0, 2_000);
      const year = r.int(-1, 9);
      expect(vaultReceiveGrossScaled(state, G, N, cap, 1n, fee, year)).toEqual(vaultReceiveGross(state, G, N, cap, fee, year));
      expect(isCappedScaled(state, cap, 1n)).toBe(isCapped(state, cap));
    }
    // and Stage 1's refusals, unchanged
    const s0 = newVaultState();
    expect(() => vaultReceiveGrossScaled(s0, 1n, 0n, 1n, 1n, 0, 0)).toThrow(/^NoUnitsOutstanding$/);
    expect(() => vaultReceiveGross(s0, 1n, 0n, 1n, 0, 0)).toThrow(/^NoUnitsOutstanding$/);
  });

  it('tailReceiveScaled ≡ tailReceive (2,000 seeded cases)', () => {
    const r = rng(0x5eed_0002n);
    for (let i = 0; i < 2_000; i++) {
      const N = r.pick([1n, 7n, r.between(1n, 10n ** 9n)]);
      const state = randomTail(r, N, 1n);
      const G = r.pick([0n, r.between(0n, 10n ** 13n)]);
      const fee = r.int(0, 2_000);
      expect(tailReceiveScaled(state, G, N, fee, 1n)).toEqual(tailReceive(state, G, N, fee));
    }
    expect(() => tailReceiveScaled(newTailState(1n), 1n, 0n, 0, 1n)).toThrow(/^NoUnitsOutstanding$/);
  });

  it('redemptionQuoteScaled ≡ redemptionQuote, capRemainingScaled ≡ its C_remaining (2,000 seeded cases)', () => {
    const r = rng(0x5eed_0003n);
    for (let i = 0; i < 2_000; i++) {
      const p0 = r.between(1n, 10n ** 9n);
      const capPerUnitValue = capPerUnit(r.between(10n ** 18n, 3n * 10n ** 18n), p0);
      const inputs: RedemptionInputs = {
        p0,
        hurdleRateWad: r.between(0n, 25n * 10n ** 16n),
        payoutMultipleK: r.int(1, 20),
        t: r.between(0n, 6n * YEAR),
        capPerUnit: capPerUnitValue,
        paidPerUnitWad: r.pick([0n, capPerUnitValue * WAD, r.between(0n, 4n * 10n ** 9n) * WAD + r.between(0n, WAD - 1n)]),
        yearGross: randomRing(r, 1n),
        unitsOutstanding: r.between(1n, 10n ** 9n),
      };
      const stage1 = redemptionQuote(inputs);
      expect(redemptionQuoteScaled({ ...inputs, unitScale: 1n })).toEqual(stage1);
      expect(capRemainingScaled(inputs.capPerUnit, inputs.paidPerUnitWad, 1n)).toBe(stage1.cRemaining);
      expect(capRemaining(inputs.capPerUnit, inputs.paidPerUnitWad)).toBe(stage1.cRemaining);
    }
  });

  it('scaledCapWad and scaledAmount at scale 1 are Stage 1\'s `cap × WAD` and `P_redeem × units`', () => {
    const r = rng(0x5eed_0004n);
    for (let i = 0; i < 1_000; i++) {
      const cap = r.between(0n, U64_MAX);
      expect(scaledCapWad(cap, 1n)).toBe(capEffWad(cap, 0n));
      const p = r.between(0n, 10n ** 9n);
      const u = r.between(0n, 10n ** 9n);
      // Stage 1's deposit and sealed redemption principal: `pRedeem × units` (reference redemption.ts:77)
      expect(scaledAmount(p, u, 1n)).toBe(p * u);
    }
    expect(wadPerScaledUnit(1n)).toBe(WAD);
  });
});

// ---------------------------------------------------------------- Stage 1's Rust tests: curve.rs

describe('curve.rs (CM curve.rs:13-205)', () => {
  it('the constants and unit_scale_for (:13-22)', () => {
    expect(CURVE_BASE_DECIMALS).toBe(6);
    expect(CURVE_UNIT_SCALE).toBe(1_000_000n);
    expect(unitScaleFor(CURVE_BASE_DECIMALS)).toBe(CURVE_UNIT_SCALE);
    expect(unitScaleFor(0)).toBe(1n);
    expect(unitScaleFor(19)).toBe(10n ** 19n);
    // checked_pow: 10^20 does not fit u64
    expect(() => unitScaleFor(20)).toThrow(/^Overflow/);
    expect(() => unitScaleFor(256)).toThrow(/^InvalidInput/);
  });

  it('p0_of_the_worked_series (:120-138)', () => {
    expect(p0PerUnit(1_000_000_000n, 100_000_000n, 6)).toBe(10_000_000n);
    expect(p0PerUnit(100_000_000_000n, 10_000_000_000n, 6)).toBe(10_000_000n);
    expect(p0PerUnit(1_000_000_000n, 100_000_002n, 6)).toBe(9_999_999n);
    expect(() => p0PerUnit(1n, 0n, 6)).toThrow(/^DivisionByZero/);
  });

  it('offer_matching_tolerates_program_rounding (:140-147)', () => {
    expect(swapBaseMatchesOffer(100_000_000n, 100n, 6)).toBe(true);
    expect(swapBaseMatchesOffer(99_999_998n, 100n, 6)).toBe(true);
    expect(swapBaseMatchesOffer(101_000_000n, 100n, 6)).toBe(true);
    expect(swapBaseMatchesOffer(98_999_999n, 100n, 6)).toBe(false);
    expect(swapBaseMatchesOffer(102_000_000n, 100n, 6)).toBe(false);
  });

  it('migration_fee_split_matches_the_program (:149-173)', () => {
    const x = 100_000_000_000n;
    expect(migrationFeeSplit(x, 0, 0)).toEqual({ partner: 0n, creator: 0n });
    expect(migrationFeeSplit(x, 20, 100)).toEqual({ partner: 0n, creator: 20_000_000_000n });
    expect(migrationFeeSplit(x, 99, 0)).toEqual({ partner: 99_000_000_000n, creator: 0n });
    expect(migrationFeeSplit(x, 99, 50)).toEqual({ partner: 49_500_000_000n, creator: 49_500_000_000n });
    expect(migrationFeeSplit(750_000_000n, 10, 50)).toEqual({ partner: 37_500_000n, creator: 37_500_000n });
    expect(migrationFeeSplit(1_000_000_000n, 99, 0)).toEqual({ partner: 990_000_000n, creator: 0n });
    // a percentage above 100 (Rust's precondition)
    expect(() => migrationFeeSplit(x, 101, 0)).toThrow(/^InvalidInput/);
    expect(() => migrationFeeSplit(x, 0, 101)).toThrow(/^InvalidInput/);
  });

  it('outstanding_and_quota (:175-184): units outstanding refuses an underflow; the quota is inclusive', () => {
    expect(() => unitsOutstanding(110n, [10n, 0n, 363n, 0n])).toThrow(/^InvalidInput/);
    expect(unitsOutstanding(1_000n, [10n, 20n, 30n, 40n])).toBe(900n);
    expect(walletTenderFits(100n, 30n, 50n, 20n)).toBe(true);
    expect(walletTenderFits(100n, 30n, 50n, 21n)).toBe(false);
    // checked_add past u64
    expect(() => unitsOutstanding(U64_MAX, [U64_MAX, 1n])).toThrow(/^Overflow/);
    expect(() => walletTenderFits(U64_MAX, U64_MAX, 1n, 0n)).toThrow(/^Overflow/);
    expect(() => unitsOutstanding(-1n, [])).toThrow(/^InvalidInput/);
  });

  it('fee_split_conserves (:188-195), seeded', () => {
    const r = rng(0x5eed_0005n);
    for (let i = 0; i < 2_000; i++) {
      const x = r.between(0n, U64_MAX / 128n);
      const f = r.int(0, 99);
      const c = r.int(0, 100);
      const { partner, creator } = migrationFeeSplit(x, f, c);
      const keep = (x * BigInt(100 - f) + 99n) / 100n;
      expect(partner + creator + keep).toBe(x);
      expect(creator * 100n <= (partner + creator) * BigInt(c)).toBe(true);
    }
  });

  it('p0_is_the_floor (:197-204), seeded', () => {
    const r = rng(0x5eed_0006n);
    for (let i = 0; i < 2_000; i++) {
      const x = r.between(1n, 10n ** 18n);
      const sb = r.between(1n, 10n ** 13n);
      const p0 = p0PerUnit(x, sb, 6);
      expect(p0 * sb <= x * 1_000_000n).toBe(true);
      expect((p0 + 1n) * sb > x * 1_000_000n).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- Stage 1's Rust tests: vault.rs, redemption.rs, properties.rs

describe('vault.rs (CM vault.rs:125-296)', () => {
  it('wad_per_scaled_unit (:125-135): the scale must divide WAD', () => {
    expect(wadPerScaledUnit(S)).toBe(10n ** 12n);
    expect(wadPerScaledUnit(WAD)).toBe(1n);
    expect(() => wadPerScaledUnit(0n)).toThrow(/^InvalidInput/);
    expect(() => wadPerScaledUnit(3n)).toThrow(/^InvalidInput/);
    expect(() => wadPerScaledUnit(10n * WAD)).toThrow(/^InvalidInput/);
  });

  it('scaled_cap_wad and scaled_amount (:137-156)', () => {
    expect(scaledCapWad(25_000_000n, S)).toBe(25n * WAD);
    expect(scaledAmount(10_000_000n, 99_999_998n, S)).toBe(999_999_980n);
    expect(() => scaledAmount(1n, 1n, 0n)).toThrow(/^DivisionByZero/);
    expect(() => scaledAmount(U64_MAX, U64_MAX, 1n)).toThrow(/^Overflow/);
  });

  it('cap_truncation_and_effective_cap (:219-247): is_capped at scale 1 and at the curve scale', () => {
    expect(isCappedScaled({ paidPerUnitWad: 2_400_000n * WAD }, 1n, 1n)).toBe(true);
    expect(isCappedScaled({ paidPerUnitWad: 2_400_000n * WAD }, 2_500_000n, 1n)).toBe(false);
    // curve-mode scale: 25 USDC per unit = 25 base units per base lamport (× WAD)
    expect(isCappedScaled({ paidPerUnitWad: 25n * WAD }, 25_000_000n, S)).toBe(true);
    expect(isCappedScaled({ paidPerUnitWad: 25n * WAD - 1n }, 25_000_000n, S)).toBe(false);
  });

  it('plain_receipt and cap_truncation_and_effective_cap (:190-247) through the wrapper at scale 1 (Stage 1 = Rust)', () => {
    const plain = vaultReceiveGrossScaled(newVaultState(), 1_000_000n, 100n, 2_500_000n, 1n, 500, 0).result;
    expect(plain).toMatchObject({ accepted: 1_000_000n, refund: 0n, incWad: 10_000n * WAD, fee: 50_000n, netAdded: 950_000n, deltaAccWad: 9_500n * WAD, carryWad: 0n, retired: false });
    const at = { ...newVaultState(), paidPerUnitWad: 2_400_000n * WAD };
    const trunc = vaultReceiveGrossScaled(at, 20_000_000n, 100n, 2_500_000n, 1n, 500, 0).result;
    expect(trunc).toMatchObject({ retired: true, accepted: 10_000_000n, refund: 10_000_000n, incWad: 100_000n * WAD });
    expect(vaultReceiveGrossScaled(at, 10_000_000n, 100n, 2_500_000n, 1n, 500, 0).result).toMatchObject({ retired: true, refund: 0n });
    expect(vaultReceiveGrossScaled(at, 9_999_999n, 100n, 2_500_000n, 1n, 500, 0).result.retired).toBe(false);
    expect(vaultReceiveGrossScaled(at, 5n, 100n, 1n, 1n, 500, 0).result).toMatchObject({ retired: true, accepted: 0n, refund: 5n });
  });

  it('zero_units_rejected (:259-266) at the curve scale too', () => {
    expect(() => vaultReceiveGrossScaled(newVaultState(), 1n, 0n, 1n, S, 0, 0)).toThrow(/^NoUnitsOutstanding$/);
    expect(() => tailReceiveScaled(newTailState(1n), 1n, 0n, 0, S)).toThrow(/^NoUnitsOutstanding$/);
  });

  it('cap_never_exceeded_and_conservation (:268-295), seeded, at scale 1 and at the curve scale', () => {
    const r = rng(0x5eed_0007n);
    for (const scale of [1n, S]) {
      for (let i = 0; i < 1_500; i++) {
        const gross = r.between(0n, 10n ** 13n - 1n);
        const units = r.between(1n, 10n ** 6n - 1n);
        const cap = r.between(1n, 10n ** 12n - 1n);
        const paid = r.between(0n, 10n ** 12n - 1n) * (WAD / scale);
        const carry = r.between(0n, 10n ** 6n - 1n) % units;
        const fee = r.int(0, 2_000);
        const state = { ...newVaultState(), paidPerUnitWad: paid, carryWad: carry };
        const out = vaultReceiveGrossScaled(state, gross, units, cap, scale, fee, 0).result;
        expect(out.accepted + out.refund).toBe(gross);
        const capEff = scaledCapWad(cap, scale) > paid ? scaledCapWad(cap, scale) : paid;
        expect(paid + out.incWad <= capEff).toBe(true);
        expect(out.accepted - out.fee).toBe(out.netAdded);
        expect(out.carryWad < units).toBe(true);
        expect(out.deltaAccWad * units + out.carryWad).toBe(out.netAdded * WAD + carry);
        const half = units / 2n;
        expect(settleHolderDelta(out.deltaAccWad, 0n, half) + settleHolderDelta(out.deltaAccWad, 0n, units - half) <= out.netAdded).toBe(true);
      }
    }
  });
});

describe('redemption.rs and properties.rs (CM redemption.rs:101-262, properties.rs:165-205, :402-418)', () => {
  const H8 = 80_000_000_000_000_000n;
  /** The Rust test's ring, and the same ring per base lamport (`/ 10^6`). */
  const ring = (entries: [number, bigint][], scale = 1n) => entries.reduce((g, [y, v]) => yearGrossAdd(g, y, v / scale), newYearGross());
  const at = (scale: bigint, paid: bigint, entries: [number, bigint][], cap: bigint, t: bigint, hurdle = H8, k = 5) =>
    rustPrice(redemptionQuoteScaled({ p0: 1_000_000n, hurdleRateWad: hurdle, payoutMultipleK: k, t, capPerUnit: cap, paidPerUnitWad: paid / scale, yearGross: ring(entries, scale), unitsOutstanding: 1n, unitScale: scale }));

  it('each_term_can_decide (:170-232), at scale 1 and per base lamport', () => {
    const y: [number, bigint][] = [[0, 300_000n * WAD], [1, 300_000n * WAD]];
    for (const scale of [1n, S]) {
      expect(at(scale, 0n, [], 2_500_000n, YEAR / 2n)).toMatchObject({ price: 1_040_000n, d_avg: 0n });
      expect(at(scale, 600_000n * WAD, y, 2_500_000n, 2n * YEAR)).toEqual({ price: 1_500_000n, hurdle: 1_166_400n, d_avg: 300_000n, cap_remaining: 1_900_000n });
      expect(at(scale, 2_000_000n * WAD, y, 2_500_000n, 2n * YEAR).price).toBe(500_000n);
    }
    // ceil rounding favours the issuer; a lowered cap saturates to 0 (scale 1: one wei past 2,000,000 base units)
    expect(at(1n, 2_000_000n * WAD + 1n, y, 2_000_000n, 2n * YEAR)).toMatchObject({ cap_remaining: 0n, price: 0n });
    // per base lamport: one wei past 2 base units per lamport is past 2,000,000 per whole unit
    expect(rustPrice(redemptionQuoteScaled({ p0: 1_000_000n, hurdleRateWad: H8, payoutMultipleK: 5, t: 2n * YEAR, capPerUnit: 2_000_000n, paidPerUnitWad: 2n * WAD + 1n, yearGross: ring(y, S), unitsOutstanding: 1n, unitScale: S }))).toMatchObject({ cap_remaining: 0n, price: 0n });
    expect(capRemainingScaled(2_000_000n, 2n * WAD + 1n, S)).toBe(0n);
    expect(capRemainingScaled(2_000_000n, 2n * WAD, S)).toBe(0n);
    expect(capRemainingScaled(2_000_000n, 2n * WAD - 10n ** 12n, S)).toBe(1n);
  });

  it('ring_retags_and_trailing_window (:234-262), at scale 1 and per base lamport', () => {
    const entries: [number, bigint][] = [[0, 900_000n * WAD], [1, 100_000n * WAD], [2, 200_000n * WAD], [3, 300_000n * WAD], [4, 5n * WAD]];
    for (const scale of [1n, S]) {
      const q = at(scale, 0n, entries, 10_000_000n, 4n * YEAR, 0n, 1);
      expect(q.d_avg).toBe(200_000n);
      expect(q.price).toBe(1_000_000n);
    }
  });

  it('redemption_price_bounds (properties.rs:165-205), seeded: the price per base lamport is the price per unit', () => {
    const r = rng(0x5eed_0008n);
    for (let i = 0; i < 1_500; i++) {
      const p0 = r.between(1n, 10n ** 9n - 1n);
      const h = r.between(0n, 25n * 10n ** 16n);
      const k = r.int(1, 20);
      const cap = capPerUnit(r.between(2n * WAD, 3n * WAD), p0);
      const paidUnits = r.between(0n, 4n * 10n ** 9n - 1n);
      const t = r.between(0n, 6n * YEAR - 1n);
      const years = [0, 1, 2, 3].map(() => r.between(0n, 5n * 10n ** 8n - 1n));
      const base = Number(t / YEAR) / 4;
      const rings = (scale: bigint) => years.reduce((g, v, y) => yearGrossAdd(g, y + Math.floor(base) * 4, (v * WAD) / scale), newYearGross());
      const N = r.between(1n, 10n ** 9n);
      const common = { p0, hurdleRateWad: h, payoutMultipleK: k, t, capPerUnit: cap };
      const q = redemptionQuoteScaled({ ...common, paidPerUnitWad: paidUnits * WAD, yearGross: rings(1n), unitsOutstanding: N, unitScale: 1n });
      const qb = redemptionQuoteScaled({ ...common, paidPerUnitWad: (paidUnits * WAD) / S, yearGross: rings(S), unitsOutstanding: N * S, unitScale: S });
      // the Rust property compares the whole RedemptionPrice; with N in base lamports the deposit is the same too
      expect(qb).toEqual(q);
      expect(q.pRedeem <= q.cRemaining).toBe(true);
      expect(q.pHurdle >= p0).toBe(true);
      if (t < YEAR) {
        expect(q.dAvg).toBeNull();
        expect(q.pRedeem).toBe(q.cRemaining < q.pHurdle ? q.cRemaining : q.pHurdle);
      }
    }
  });

  it('tenders_never_exceed_the_deposit (properties.rs:402-418), seeded', () => {
    const r = rng(0x5eed_0009n);
    for (let i = 0; i < 1_000; i++) {
      const price = r.between(1n, 10n ** 9n - 1n);
      const parts = Array.from({ length: r.int(1, 19) }, () => r.between(1n, 5n * 10n ** 9n - 1n));
      const q = parts.reduce((a, b) => a + b, 0n);
      const deposit = scaledAmount(price, q, S);
      expect(parts.reduce((a, u) => a + scaledAmount(price, u, S), 0n) <= deposit).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- the fixtures and the LiteSVM curve tests

describe('Stage 1\'s curve fixtures and curve_mode.rs figures', () => {
  const N = big(curveReports.fixtures[0]!.units_outstanding); // 99,999,998 base lamports
  const P0 = big(curveConfig.expected.p0PerUnit!);
  const cap = capPerUnit(DEFAULT_PARAMETERS.capMultipleWad, P0); // Parameters::DEFAULT (CM params.rs:48)
  const feeBps = Number(DEFAULT_PARAMETERS.payoutFeeBps); // 500 (CM params.rs:54)

  it('FX curve_config.json `expected`: P0, the offer and both migration-fee splits', () => {
    const e = curveConfig.expected;
    expect(p0PerUnit(big(e.migrationQuoteThreshold!), big(e.swapBaseAmount!), Number(e.tokenDecimal))).toBe(big(e.p0PerUnit!));
    expect(P0).toBe(10_000_000n);
    // the series offers 100 units (tests/src/curve.rs:117-122 `curve_series_args`)
    expect(swapBaseMatchesOffer(big(e.swapBaseAmount!), 100n, Number(e.tokenDecimal))).toBe(true);
    expect(migrationFeeSplit(big(e.migrationQuoteThreshold!), Number(e.migrationFeePercentage), Number(e.creatorMigrationFeePercentage))).toEqual({
      partner: big(e.partnerMigrationFee!),
      creator: big(e.creatorMigrationFee!),
    });
    const pda = curveConfig.pdaCreator.expected;
    expect(p0PerUnit(big(pda.migrationQuoteThreshold!), big(pda.swapBaseAmount!), Number(pda.tokenDecimal))).toBe(big(pda.p0PerUnit!));
    expect(migrationFeeSplit(big(pda.migrationQuoteThreshold!), Number(pda.migrationFeePercentage), Number(pda.creatorMigrationFeePercentage))).toEqual({
      partner: big(pda.partnerMigrationFee!),
      creator: big(pda.creatorMigrationFee!),
    });
    // CMT:1020-1024: on the PDA-creator pool both shares are withdrawn into the treasury, 990 USDC in all
    const both = migrationFeeSplit(big(pda.migrationQuoteThreshold!), Number(pda.migrationFeePercentage), Number(pda.creatorMigrationFeePercentage));
    expect(both.partner + both.creator).toBe(990n * USDC);
  });

  it('CMT:286-303 the first payment per base lamport: exact accumulator and carry, nothing capped', () => {
    const due = big(curveReports.fixtures[0]!.payment_usd);
    expect(due).toBe(1_999_999_960n); // CMT:293
    expect(cap).toBe(25n * USDC);
    const { state, result } = vaultReceiveGrossScaled(newVaultState(), due, N, cap, S, feeBps, 0);
    const net = due - (due * BigInt(feeBps)) / 10_000n;
    expect(result).toMatchObject({ accepted: due, refund: 0n, retired: false, netAdded: net });
    // CMT:299-303: net_acc_wad × n + carry_wad == net × WAD
    expect(state.netAccWad * N + state.carryWad).toBe(net * WAD);
    // the fixture is exact: 20 base units gross and 19 net per base lamport (×WAD), no carry
    expect([state.paidPerUnitWad, state.netAccWad, state.carryWad]).toEqual([20n * WAD, 19n * WAD, 0n]);
    expect(isCappedScaled(state, cap, S)).toBe(false);
    // CMT:312-313: a holder of `a` staked base lamports is paid holder_delta(net_acc_wad, 0, a)
    expect(settleHolderDelta(state.netAccWad, 0n, 10n * S)).toBe(190n * USDC);
  });

  it('CMT:926-946 the past-the-cap payment retires the series per base lamport, and only per base lamport', () => {
    const due = big(curveReports.fixtures[1]!.payment_usd);
    expect(due).toBe(13_999_999_720n); // CMT:929
    const capWad = scaledCapWad(25n * USDC, S); // CMT:938
    const { state, result } = vaultReceiveGrossScaled(newVaultState(), due, N, cap, S, feeBps, 0);
    expect(result.retired).toBe(true);
    expect(state.paidPerUnitWad <= capWad).toBe(true); // CMT:940
    const accepted = (N * capWad) / WAD; // CMT:942
    expect(result.accepted <= accepted + 1n).toBe(true); // CMT:943
    expect(result.accepted).toBe(2_499_999_950n);
    expect(result.refund).toBe(due - 2_499_999_950n); // CMT:944-947: the capping receipt refunds the excess
    expect(state.refundedToIssuer > 0n).toBe(true);
    expect(isCappedScaled(state, cap, S)).toBe(true);
    // Stage 1's TypeScript (scale 1) would read the cap as 25 USDC per base lamport and accept everything
    expect(vaultReceiveGross(newVaultState(), due, N, cap, feeBps, 0).result).toMatchObject({ accepted: due, retired: false });
  });

  it('CMT:330-344 and :349-372 the redemption per base lamport: the price, the deposit, the tenders', () => {
    // after the first payment (20 USDC per unit paid against a 25 USDC cap): C_remaining = 5 USDC < the hurdle (≥ P0),
    // so P_redeem = 5 USDC for any redemption time in the first year (derived; CMT asserts price > 0 and the deposit)
    const paid = vaultReceiveGrossScaled(newVaultState(), big(curveReports.fixtures[0]!.payment_usd), N, cap, S, feeBps, 0).state;
    const r = rng(0x5eed_000an);
    for (const t of [0n, 3_600n, r.between(0n, YEAR - 1n), YEAR - 1n]) {
      const q = redemptionQuoteScaled({ p0: P0, hurdleRateWad: DEFAULT_PARAMETERS.hurdleRateWad, payoutMultipleK: Number(DEFAULT_PARAMETERS.payoutMultipleK), t, capPerUnit: cap, paidPerUnitWad: paid.paidPerUnitWad, yearGross: paid.yearGross, unitsOutstanding: N, unitScale: S });
      expect(q).toMatchObject({ pRedeem: 5n * USDC, cRemaining: 5n * USDC, paidUnits: 20n * USDC, decidedBy: 'cap_remaining', tailCapPerUnit: 0n });
      // CMT:340-344: deposit = scaled_amount(price, n, CURVE_UNIT_SCALE)
      expect(q.deposit).toBe(scaledAmount(5n * USDC, N, S));
      expect(q.deposit).toBe(499_999_990n);
      expect(capRemainingScaled(cap, paid.paidPerUnitWad, S)).toBe(5n * USDC);
    }
    // CMT:349-372: a tender of u base lamports pays scaled_amount(price, u, 10^6); 10 whole units pay 50 USDC
    expect(scaledAmount(5n * USDC, 10n * S, S)).toBe(50n * USDC);
    // CMT:392-410: the wallet quota is exactly what is neither tendered nor staked
    const tendered = 60_000_000n;
    const staked = 15n * S;
    const quota = N - tendered - staked;
    expect(walletTenderFits(N, tendered, staked, quota)).toBe(true);
    expect(walletTenderFits(N, tendered, staked, quota + 1n)).toBe(false);
    expect(walletTenderFits(N, tendered + quota, staked, 1n)).toBe(false);
    // the tail cap is 0: any tail receipt is refunded and exhausts the tail at once
    expect(tailReceiveScaled(newTailState(0n), 1_000n, N, feeBps, S).result).toMatchObject({ accepted: 0n, refund: 1_000n, exhausted: true });
  });
});

// ---------------------------------------------------------------- our scale invariance (vault, tail)

describe('scale invariance of the ported bodies (ours, after properties.rs:165-205)', () => {
  it('the vault per base lamport accepts, refunds, charges and retires exactly as Stage 1 per whole unit', () => {
    const r = rng(0x5eed_000bn);
    for (let i = 0; i < 2_000; i++) {
      const N1 = r.between(1n, 10n ** 9n);
      const cap = r.between(0n, 10n ** 12n);
      const one = randomVault(r, N1, cap, S); // accumulators multiples of 10^6
      const lam: VaultState = { ...one, paidPerUnitWad: one.paidPerUnitWad / S, yearGross: one.yearGross.map((s) => ({ ...s, grossWad: s.grossWad / S })) as unknown as YearGrossRing, carryWad: 0n };
      const G = r.pick([0n, r.between(0n, 10n ** 13n)]);
      const fee = r.int(0, 2_000);
      const year = r.int(0, 8);
      const a = vaultReceiveGross({ ...one, carryWad: 0n }, G, N1, cap, fee, year);
      const b = vaultReceiveGrossScaled(lam, G, N1 * S, cap, S, fee, year);
      expect([b.result.accepted, b.result.refund, b.result.fee, b.result.netAdded, b.result.retired]).toEqual([a.result.accepted, a.result.refund, a.result.fee, a.result.netAdded, a.result.retired]);
      expect(b.result.incWad).toBe(a.result.incWad / S);
      expect(b.state.paidPerUnitWad).toBe(a.state.paidPerUnitWad / S);
      for (let y = 0; y < 12; y++) expect(yearGrossGet(b.state.yearGross, y)).toBe(yearGrossGet(a.state.yearGross, y) / S);
      expect(isCappedScaled(b.state, cap, S)).toBe(isCapped(a.state, cap));
      expect(capRemainingScaled(cap, b.state.paidPerUnitWad, S)).toBe(capRemaining(cap, a.state.paidPerUnitWad));
    }
  });

  it('the tail per base lamport accepts, refunds, charges and exhausts exactly as Stage 1 per whole unit', () => {
    const r = rng(0x5eed_000cn);
    for (let i = 0; i < 2_000; i++) {
      const N1 = r.between(1n, 10n ** 9n);
      const one = randomTail(r, N1, S);
      const lam: TailState = { ...one, tailPaidPerUnitWad: one.tailPaidPerUnitWad / S, tailCarryWad: 0n };
      const G = r.pick([0n, r.between(0n, 10n ** 13n)]);
      const fee = r.int(0, 2_000);
      const a = tailReceive({ ...one, tailCarryWad: 0n }, G, N1, fee);
      const b = tailReceiveScaled(lam, G, N1 * S, fee, S);
      expect([b.result.accepted, b.result.refund, b.result.fee, b.result.exhausted]).toEqual([a.result.accepted, a.result.refund, a.result.fee, a.result.exhausted]);
      expect(b.state.tailPaidPerUnitWad).toBe(a.state.tailPaidPerUnitWad / S);
      expect(b.state.tailAccWad * N1 * S + b.state.tailCarryWad - lam.tailAccWad * N1 * S).toBe((a.result.accepted - a.result.fee) * WAD);
    }
  });
});

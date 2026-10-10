/**
 * The curve-port gate's corpus: deterministic cases for every oracle entry point, edge values first and then seeded
 * random draws within Stage 1's input ranges (the ranges of merces-common's own property tests and of the sdk's
 * `PARAMETER_BOUNDS`, which Stage 1's programs enforce at series creation). The same seed gives the same corpus on
 * every machine; its fingerprint is printed with the result.
 *
 * Ranges, by input (S = 10^6, the curve scale; Stage 1's two unit scales are 1 and S, `curve.rs:13-22`):
 * - unit scale: 1 or S, sometimes another power of ten up to 10^18 (every scale dividing WAD), and, as edges, scales
 *   that do not divide WAD and 0 (both sides refuse);
 * - units: 1 to 10^9 whole units at the scale (properties.rs:165-205 draws up to 10^9), plus 0 as an edge;
 * - payments: 0 to 10^13 base units (vault.rs:268-295), plus u64 edges; fees 0 to 2,000 bps (`PARAMETER_BOUNDS`),
 *   10,000 as an edge;
 * - prices: P0 1 to 10^9 (properties.rs:165-205), hurdle 0 to 25 % (`PARAMETER_BOUNDS`), k 1 to 20, the cap from a
 *   cap multiple of 2 to 3 (Stage 1's `capPerUnit`), elapsed time 0 to 6 years;
 * - accumulators: from zero to the cap, at it and above it (a lowered cap), with random sub-unit remainders, so the
 *   `<` boundary of the cap and the ceiling of `C_remaining` are both crossed; the tail only up to its cap (its cap is
 *   fixed at redemption, so a tail accumulator above it is unreachable);
 * - curve configs: thresholds and swap bases up to the u64 edges (P0 overflows past u64 on both sides), decimals 0 to
 *   255 (10^20 and up overflow u64), fee percentages 0 to 100 and past it (both refuse), and thresholds that put the
 *   pool share `X × (100 − f) / 100` on its rounding edge (residue 1, 99 or 0), where a ceiling and a floor differ;
 * - the census and the tender quota: sums below, at and past the supply or the snapshot, and past u64.
 */
import { createHash } from 'node:crypto';
import { capPerUnit, PARAMETER_BOUNDS, U64_MAX, WAD, YEAR } from '@merces/math';
import type { OracleCase, OracleFn, WireSlot } from './family.ts';
import { wire } from './family.ts';

export const CORPUS_SEED = 0x5747_4154_45n; // "GATE"

const S = 1_000_000n;

/** A seeded xorshift64 generator (deterministic, no dependency). */
export function rng(seed: bigint) {
  const M = (1n << 64n) - 1n;
  let x = seed & M || 1n;
  const next64 = () => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return x;
  };
  /** Uniform enough in [lo, hi] (inclusive) for ranges up to 2^128. */
  const between = (lo: bigint, hi: bigint): bigint => (hi <= lo ? lo : lo + (((next64() << 64n) | next64()) % (hi - lo + 1n)));
  const int = (lo: number, hi: number) => Number(between(BigInt(lo), BigInt(hi)));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const chance = (p: number) => int(0, 9_999) < p * 10_000;
  /** Mostly small, sometimes huge: a log-uniform draw in [lo, hi]. */
  const wide = (lo: bigint, hi: bigint): bigint => {
    const digits = hi.toString().length;
    const cap = 10n ** BigInt(int(1, digits));
    const top = cap < hi ? cap : hi;
    return between(lo, top < lo ? lo : top);
  };
  return { between, int, pick, chance, wide };
}
type Rng = ReturnType<typeof rng>;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const POW10 = Array.from({ length: 20 }, (_, k) => 10n ** BigInt(k));
const FEE_MAX = PARAMETER_BOUNDS.payoutFeeBps.max;

/** A scale as Stage 1 uses one: 1 or S mostly, another divisor of WAD sometimes. */
function scale(r: Rng): bigint {
  const p = r.int(0, 99);
  return p < 45 ? 1n : p < 90 ? S : POW10[r.int(1, 18)]!;
}

/** Units at a scale: 1 to 10^9 whole units' worth of accounting units, with the small edges. */
function units(r: Rng, sc: bigint): bigint {
  const hi = min(10n ** 9n * sc, U64_MAX);
  return r.pick([1n, 2n, 3n, 7n, sc, r.wide(1n, hi), r.between(1n, hi), r.between(1n, hi)]);
}

function emptyRing(): WireSlot[] {
  return [0, 1, 2, 3].map(() => ({ year: null, gross_wad: 0n }));
}

/** A ring written the way the ledger writes it (re-tagging older years), per accounting unit at the scale. */
function ring(r: Rng, sc: bigint, years = 8): WireSlot[] {
  const slots = emptyRing();
  for (let i = r.int(0, 6); i > 0; i--) {
    const y = r.int(0, years);
    const inc = (r.between(0n, 5n * 10n ** 8n) * WAD) / sc + r.between(0n, 999n);
    const slot = slots[y % 4]!;
    if (slot.year !== y) {
      slot.year = y;
      slot.gross_wad = 0n;
    }
    slot.gross_wad += inc;
  }
  return slots;
}

/**
 * An accumulator against a cap: zero, below, near, at or above it (above by up to 10^12 base units per whole unit,
 * `den` being the WAD value of one base unit per whole unit at the scale).
 */
function accumulator(r: Rng, capWad: bigint, den: bigint, aboveAllowed: boolean): bigint {
  const choices = ['zero', 'below', 'below', 'near', 'at'] as const;
  const kind = aboveAllowed ? r.pick([...choices, 'above'] as const) : r.pick(choices);
  switch (kind) {
    case 'zero':
      return 0n;
    case 'below':
      return r.between(0n, capWad);
    case 'near':
      return max(0n, capWad - r.between(0n, 10n ** 6n));
    case 'at':
      return capWad;
    case 'above':
      return capWad + r.wide(1n, 10n ** 12n * den);
  }
}

/** A gross amount, with the one that lands exactly on the cap (and one either side) when it exists. */
function gross(r: Rng, capEff: bigint, paid: bigint, n: bigint): bigint {
  const room = capEff > paid ? capEff - paid : 0n;
  // a payment is a u64 (the receipt's `gross`): the amount that lands on the cap is clamped to it
  const exact = min((room * n) / WAD, U64_MAX);
  return r.pick([0n, 1n, exact, min(exact + 1n, U64_MAX), exact > 0n ? exact - 1n : 0n, r.wide(0n, 10n ** 13n), r.between(0n, 10n ** 13n), r.chance(0.05) ? U64_MAX : r.between(0n, 10n ** 13n)]);
}

function fee(r: Rng): number {
  return Number(r.pick([0n, FEE_MAX, 10_000n, r.between(0n, FEE_MAX), r.between(0n, FEE_MAX), 500n]));
}

type Gen = (r: Rng) => Record<string, unknown>;

/** The random half of each entry point; the edges are listed in `edges` below. */
const RANDOM: Record<Exclude<OracleFn, 'constants' | 'unit_scale_for'>, { count: number; gen: Gen }> = {
  wad_per_scaled_unit: {
    count: 120,
    gen: (r) => ({ unit_scale: r.pick([r.between(0n, U64_MAX), 2n ** BigInt(r.int(0, 18)) * 5n ** BigInt(r.int(0, 18)), POW10[r.int(0, 19)]!, r.wide(0n, U64_MAX)]) }),
  },
  scaled_cap_wad: {
    count: 200,
    gen: (r) => ({ cap_per_unit: r.pick([r.wide(0n, U64_MAX), r.between(0n, 10n ** 12n), U64_MAX]), unit_scale: r.pick([scale(r), scale(r), r.wide(0n, 10n ** 19n)]) }),
  },
  scaled_amount: {
    count: 300,
    gen: (r) => {
      const sc = r.pick([scale(r), scale(r), scale(r), 0n, r.wide(1n, U64_MAX)]);
      return { price: r.pick([r.between(0n, 10n ** 10n), r.wide(0n, U64_MAX)]), units: r.pick([units(r, sc === 0n ? 1n : min(sc, 10n ** 9n)), r.wide(0n, U64_MAX)]), unit_scale: sc };
    },
  },
  is_capped: {
    count: 250,
    gen: (r) => {
      const sc = r.chance(0.05) ? r.pick([0n, 3n, 7n * S]) : scale(r);
      const cap = r.pick([0n, 1n, r.between(0n, 10n ** 12n), r.wide(0n, U64_MAX)]);
      const den = sc !== 0n && WAD % sc === 0n ? WAD / sc : WAD;
      const capWad = cap * den;
      return { cap_per_unit: cap, paid_per_unit_wad: r.pick([capWad, capWad + 1n, capWad > 0n ? capWad - 1n : 0n, accumulator(r, capWad, den, true)]), unit_scale: sc };
    },
  },
  receive_gross: {
    count: 1_200,
    gen: (r) => {
      const sc = r.chance(0.01) ? r.pick([3n, 0n]) : scale(r);
      const n = r.chance(0.01) ? 0n : units(r, sc === 0n || sc === 3n ? 1n : sc);
      const cap = r.chance(0.1) ? r.pick([0n, 1n]) : r.chance(0.5) ? r.between(1n, 10n ** 12n) : capPerUnit(r.between(PARAMETER_BOUNDS.capMultipleWad.min, PARAMETER_BOUNDS.capMultipleWad.max), r.between(1n, 10n ** 9n));
      const den = sc !== 0n && WAD % sc === 0n ? WAD / sc : WAD;
      const capWad = cap * den;
      const paid = accumulator(r, capWad, den, true);
      const g = gross(r, max(capWad, paid), paid, n);
      // the ledger's running totals are u64 (common.rs:563-575): keep them clear of u64 after this receipt
      const room = U64_MAX - g;
      return {
        gross: g,
        units: n,
        cap_per_unit: cap,
        unit_scale: sc,
        paid_per_unit_wad: paid,
        carry_wad: n === 0n ? 0n : r.pick([0n, n - 1n, r.between(0n, n - 1n)]),
        fee_bps: fee(r),
        net_acc_wad: r.wide(0n, 10n ** 30n),
        gross_received: r.wide(0n, min(10n ** 15n, room)),
        fee_collected: r.wide(0n, min(10n ** 13n, room)),
        refunded_to_issuer: r.wide(0n, min(10n ** 13n, room)),
        ring: ring(r, sc === 0n || sc === 3n ? 1n : sc),
        year: r.int(0, 12),
      };
    },
  },
  receive_tail: {
    count: 600,
    gen: (r) => {
      const sc = r.chance(0.01) ? 3n : scale(r);
      const n = r.chance(0.01) ? 0n : units(r, sc === 3n ? 1n : sc);
      const cap = r.pick([0n, 1n, r.between(0n, 10n ** 10n), r.between(0n, 10n ** 7n)]);
      const den = WAD % sc === 0n ? WAD / sc : WAD;
      const capWad = cap * den;
      const paid = accumulator(r, capWad, den, false);
      return {
        gross: gross(r, capWad, paid, n),
        units: n,
        tail_cap_per_unit: cap,
        unit_scale: sc,
        tail_paid_per_unit_wad: paid,
        tail_carry_wad: n === 0n ? 0n : r.pick([0n, n - 1n, r.between(0n, n - 1n)]),
        fee_bps: fee(r),
        tail_acc_wad: r.wide(0n, 10n ** 30n),
      };
    },
  },
  cap_remaining: {
    count: 250,
    gen: (r) => {
      const sc = r.chance(0.04) ? r.pick([0n, 3n]) : scale(r);
      const cap = r.pick([0n, 1n, r.between(0n, 10n ** 10n), r.wide(0n, 10n ** 12n)]);
      const den = sc !== 0n && WAD % sc === 0n ? WAD / sc : WAD;
      const capWad = cap * den;
      return { cap_per_unit: cap, paid_per_unit_wad: r.pick([capWad, capWad + 1n, capWad - min(capWad, den), capWad - min(capWad, den) + 1n, accumulator(r, capWad, den, true), r.between(0n, capWad + 10n * den)]), unit_scale: sc };
    },
  },
  redemption_price: {
    count: 800,
    gen: (r) => {
      const sc = scale(r);
      const p0 = r.pick([1n, 10n ** 9n, 10_000_000n, r.between(1n, 10n ** 9n), r.wide(1n, 10n ** 9n)]);
      const cap = r.chance(0.1) ? r.pick([0n, r.between(0n, 10n ** 10n)]) : capPerUnit(r.between(PARAMETER_BOUNDS.capMultipleWad.min, PARAMETER_BOUNDS.capMultipleWad.max), p0);
      const den = WAD / sc;
      const below = () => r.between(0n, cap) * den + r.between(0n, den - 1n);
      const paid = r.pick([0n, 0n, cap * den, cap * den + 1n, below(), below(), below(), r.between(0n, 4n * 10n ** 9n) * den + r.between(0n, den - 1n), accumulator(r, cap * den, den, true)]);
      const t = r.pick([0n, YEAR - 1n, YEAR, YEAR + 1n, 2n * YEAR, 3n * YEAR, 4n * YEAR, YEAR / 2n, r.between(0n, 6n * YEAR), r.between(0n, 6n * YEAR)]);
      const settlement = r.between(0n, 2_000_000_000n);
      return {
        clearing_price: p0,
        hurdle_rate_wad: r.pick([0n, PARAMETER_BOUNDS.hurdleRateWad.max, 80_000_000_000_000_000n, r.between(0n, PARAMETER_BOUNDS.hurdleRateWad.max)]),
        payout_multiple_k: r.int(Number(PARAMETER_BOUNDS.payoutMultipleK.min), Number(PARAMETER_BOUNDS.payoutMultipleK.max)),
        cap_per_unit: cap,
        paid_per_unit_wad: paid,
        ring: r.chance(0.1) ? emptyRing() : ring(r, sc, Number(t / YEAR) + 1),
        settlement_ts: settlement,
        now: settlement + t,
        unit_scale: sc,
        units: r.chance(0.02) ? 0n : units(r, sc),
      };
    },
  },
  p0_per_unit: {
    count: 350,
    gen: (r) => ({
      migration_quote_threshold: r.pick([0n, 1n, U64_MAX, r.between(1n, 10n ** 15n), r.wide(0n, U64_MAX)]),
      swap_base_amount: r.pick([0n, 1n, U64_MAX, r.between(1n, 10n ** 13n), r.wide(0n, U64_MAX)]),
      token_decimal: r.chance(0.7) ? 6 : r.int(0, 21),
    }),
  },
  swap_base_matches_offer: {
    count: 280,
    gen: (r) => {
      const d = r.chance(0.8) ? 6 : r.int(0, 21);
      const offered = r.pick([0n, 1n, 100n, r.between(0n, 10n ** 10n), r.chance(0.1) ? U64_MAX : 10_000n]);
      const sc = d <= 19 ? 10n ** BigInt(d) : 1n;
      const base = offered * sc;
      const near = r.pick([base, base + sc, base - min(base, sc), base + 2n * sc, base - min(base, 2n * sc), base - min(base, 1n), base + 2n * sc - 1n, r.wide(0n, U64_MAX)]);
      return { swap_base_amount: min(near, U64_MAX), units_offered: offered, token_decimal: d };
    },
  },
  units_outstanding: {
    count: 280,
    gen: (r) => {
      const supply = r.pick([0n, U64_MAX, r.between(0n, 10n ** 15n), r.wide(0n, U64_MAX)]);
      const held: bigint[] = [];
      for (let i = r.int(0, 5); i > 0; i--) held.push(r.pick([0n, r.between(0n, supply / 4n + 1n), r.wide(0n, U64_MAX)]));
      if (r.chance(0.3) && held.length) {
        // land exactly on the supply, or one past it
        const rest = held.slice(0, -1).reduce((x, y) => x + y, 0n);
        held[held.length - 1] = rest <= supply ? supply - rest + (r.chance(0.5) ? 0n : 1n) : 0n;
      }
      return { supply, protocol_held: held.map((h) => min(h, U64_MAX)) };
    },
  },
  migration_fee_split: {
    count: 400,
    gen: (r) => {
      const f = r.chance(0.04) ? r.pick([101, 200, 255]) : r.int(0, 100);
      const c = r.chance(0.04) ? r.pick([101, 255]) : r.int(0, 100);
      let x = r.pick([0n, 1n, 99n, 100n, U64_MAX, r.between(0n, U64_MAX / 128n), r.wide(0n, U64_MAX)]);
      if (f >= 1 && f <= 99 && r.chance(0.5)) {
        // put the pool share's ceiling on its edge: X × (100 − f) ≡ 1, 99 or 0 (mod 100)
        const want = BigInt(r.pick([1, 1, 99, 99, 0]));
        const keep = BigInt(100 - f);
        const base = r.wide(0n, U64_MAX - 100n);
        for (let i = 0n; i < 100n; i++) {
          if (((base + i) * keep) % 100n === want) {
            x = base + i;
            break;
          }
        }
      }
      return { migration_quote_threshold: x, fee_percentage: f, creator_fee_percentage: c };
    },
  },
  wallet_tender_fits: {
    count: 280,
    gen: (r) => {
      const uar = r.pick([0n, U64_MAX, r.between(0n, 10n ** 15n), r.wide(0n, U64_MAX)]);
      const tendered = r.between(0n, uar);
      const staked = r.between(0n, uar - tendered);
      const quota = uar - tendered - staked;
      return {
        units_at_redemption: uar,
        tendered_total: r.chance(0.05) ? U64_MAX : tendered,
        staked_total: staked,
        amount: r.pick([0n, quota, quota + 1n, quota > 0n ? quota - 1n : 0n, r.wide(0n, U64_MAX)]),
      };
    },
  },
};

/** The fixed cases: every u8 decimal, scale and u64 edges, and Stage 1's own fixture and unit-test inputs. */
function edges(): [OracleFn, Record<string, unknown>][] {
  const out: [OracleFn, Record<string, unknown>][] = [['constants', {}]];
  for (let d = 0; d <= 255; d++) out.push(['unit_scale_for', { decimals: d }]);
  const scales = [0n, 1n, 2n, 3n, 5n, 7n, 9n, 11n, 2n ** 18n, 5n ** 18n, ...POW10, 2n * 10n ** 18n, 10n ** 18n + 1n, U64_MAX - 1n, U64_MAX];
  for (const s of scales) out.push(['wad_per_scaled_unit', { unit_scale: s }]);
  for (const s of scales) for (const cap of [0n, 1n, 25_000_000n, U64_MAX]) out.push(['scaled_cap_wad', { cap_per_unit: cap, unit_scale: s }]);
  for (const s of [0n, 1n, S, U64_MAX]) for (const p of [0n, 1n, 5_000_000n, U64_MAX]) for (const u of [0n, 1n, 99_999_998n, U64_MAX]) out.push(['scaled_amount', { price: p, units: u, unit_scale: s }]);
  // Stage 1's fixture and unit-test inputs (figures.ts lists the expected answers with their citations)
  for (const [x, sb, d] of [[1_000_000_000n, 100_000_000n, 6], [100_000_000_000n, 10_000_000_000n, 6], [1_000_000_000n, 100_000_002n, 6], [1n, 0n, 6], [1n, 0n, 20], [U64_MAX, 1n, 19]] as const) {
    out.push(['p0_per_unit', { migration_quote_threshold: x, swap_base_amount: sb, token_decimal: d }]);
  }
  for (const sb of [100_000_000n, 99_999_998n, 101_000_000n, 98_999_999n, 102_000_000n]) out.push(['swap_base_matches_offer', { swap_base_amount: sb, units_offered: 100n, token_decimal: 6 }]);
  for (const [x, f, c] of [[100_000_000_000n, 0, 0], [100_000_000_000n, 20, 100], [100_000_000_000n, 99, 0], [100_000_000_000n, 99, 50], [750_000_000n, 10, 50], [1_000_000_000n, 99, 0], [1_000_000_000n, 99, 50], [U64_MAX, 100, 100], [U64_MAX, 1, 99], [1n, 101, 0], [1n, 0, 101]] as const) {
    out.push(['migration_fee_split', { migration_quote_threshold: x, fee_percentage: f, creator_fee_percentage: c }]);
  }
  for (const [supply, held] of [[110n, [10n, 0n, 363n, 0n]], [1_000n, [10n, 20n, 30n, 40n]], [110_363_638n, [7n, 363_630n, 10_000_000n, 3n]], [110_363_638n, [7n, 363_630n, 6_000_000n, 3n]], [110_363_638n, [7n, 263_630n, 6_000_000n, 3n]], [U64_MAX, [U64_MAX, 1n]], [0n, []], [5n, [5n]]] as const) {
    out.push(['units_outstanding', { supply, protocol_held: [...held] }]);
  }
  for (const [u, t, s, a] of [[100n, 30n, 50n, 20n], [100n, 30n, 50n, 21n], [U64_MAX, U64_MAX, 1n, 0n], [U64_MAX, 0n, 0n, U64_MAX], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 1n]] as const) {
    out.push(['wallet_tender_fits', { units_at_redemption: u, tendered_total: t, staked_total: s, amount: a }]);
  }
  for (const [cap, paid, s] of [[1n, 2_400_000n * WAD, 1n], [2_500_000n, 2_400_000n * WAD, 1n], [25_000_000n, 25n * WAD, S], [25_000_000n, 25n * WAD - 1n, S]] as const) {
    out.push(['is_capped', { cap_per_unit: cap, paid_per_unit_wad: paid, unit_scale: s }]);
  }
  for (const [cap, paid, s] of [[2_000_000n, 2n * WAD + 1n, S], [2_000_000n, 2n * WAD, S], [2_000_000n, 2n * WAD - 10n ** 12n, S], [25_000_000n, 20n * WAD, S], [2_000_000n, 2_000_000n * WAD + 1n, 1n]] as const) {
    out.push(['cap_remaining', { cap_per_unit: cap, paid_per_unit_wad: paid, unit_scale: s }]);
  }
  // the vault (vault.rs:190-266 at scale 1) and the curve fixture's two payments per base lamport (curve_mode.rs)
  const vault = (g: bigint, n: bigint, cap: bigint, s: bigint, paid: bigint, carry: bigint, feeBps: number) =>
    ['receive_gross', { gross: g, units: n, cap_per_unit: cap, unit_scale: s, paid_per_unit_wad: paid, carry_wad: carry, fee_bps: feeBps, net_acc_wad: 0n, gross_received: 0n, fee_collected: 0n, refunded_to_issuer: 0n, ring: emptyRing(), year: 0 }] as [OracleFn, Record<string, unknown>];
  out.push(vault(1_000_000n, 100n, 2_500_000n, 1n, 0n, 0n, 500), vault(1n, 3n, U64_MAX / 4n, 1n, 0n, 0n, 0), vault(1n, 3n, U64_MAX / 4n, 1n, 0n, 1n, 0), vault(1n, 3n, U64_MAX / 4n, 1n, 0n, 2n, 0));
  for (const g of [20_000_000n, 10_000_000n, 9_999_999n]) out.push(vault(g, 100n, 2_500_000n, 1n, 2_400_000n * WAD, 0n, 500));
  out.push(vault(5n, 100n, 1n, 1n, 2_400_000n * WAD, 0n, 500), vault(1n, 0n, 1n, 1n, 0n, 0n, 0), vault(1n, 0n, 1n, S, 0n, 0n, 0));
  out.push(vault(1_999_999_960n, 99_999_998n, 25_000_000n, S, 0n, 0n, 500), vault(13_999_999_720n, 99_999_998n, 25_000_000n, S, 0n, 0n, 500), vault(U64_MAX, 1n, U64_MAX, 1n, 0n, 0n, 10_000));
  out.push(['receive_tail', { gross: 1_000n, units: 99_999_998n, tail_cap_per_unit: 0n, unit_scale: S, tail_paid_per_unit_wad: 0n, tail_carry_wad: 0n, fee_bps: 500, tail_acc_wad: 0n }]);
  out.push(['receive_tail', { gross: 1n, units: 0n, tail_cap_per_unit: 1n, unit_scale: S, tail_paid_per_unit_wad: 0n, tail_carry_wad: 0n, fee_bps: 0, tail_acc_wad: 0n }]);
  // redemption.rs:158-262 at scale 1 and per base lamport (the ring and accumulators divided by S)
  const H8 = 80_000_000_000_000_000n;
  const redeem = (s: bigint, t: bigint, cap: bigint, paid: bigint, entries: [number, bigint][], h = H8, k = 5, p0 = 1_000_000n, n = 1n) => {
    const slots = emptyRing();
    for (const [y, g] of entries) {
      const slot = slots[y % 4]!;
      if (slot.year !== y) {
        slot.year = y;
        slot.gross_wad = 0n;
      }
      slot.gross_wad += g / s;
    }
    return ['redemption_price', { clearing_price: p0, hurdle_rate_wad: h, payout_multiple_k: k, cap_per_unit: cap, paid_per_unit_wad: paid / s, ring: slots, settlement_ts: 0n, now: t, unit_scale: s, units: n }] as [OracleFn, Record<string, unknown>];
  };
  const y2: [number, bigint][] = [[0, 300_000n * WAD], [1, 300_000n * WAD]];
  for (const s of [1n, S]) {
    for (const t of [0n, YEAR, 2n * YEAR, YEAR / 2n, YEAR + YEAR / 2n]) out.push(redeem(s, t, 2_500_000n, 0n, []));
    out.push(redeem(s, 2n * YEAR, 2_500_000n, 600_000n * WAD, y2), redeem(s, 2n * YEAR, 2_500_000n, 2_000_000n * WAD, y2), redeem(s, 2n * YEAR, 2_000_000n, 2_000_000n * WAD + s, y2));
    out.push(redeem(s, 4n * YEAR, 10_000_000n, 0n, [[0, 900_000n * WAD], [1, 100_000n * WAD], [2, 200_000n * WAD], [3, 300_000n * WAD], [4, 5n * WAD]], 0n, 1));
  }
  // the curve redemption after the fixture's first payment: 20 USDC paid per unit of a 25 USDC cap, P0 10 USDC
  for (const t of [0n, 3_600n, YEAR - 1n, YEAR]) out.push(redeem(S, t, 25_000_000n, 20n * WAD * S, [[0, 20n * WAD * S]], H8, 5, 10_000_000n, 99_999_998n));
  return out;
}

export interface Corpus {
  cases: OracleCase[];
  /** first 16 hex digits of the sha256 of the wire lines */
  fingerprint: string;
  /** cases per entry point */
  counts: Record<OracleFn, number>;
}

/** The corpus for a seed: the fixed edges, then `count` random cases per entry point. */
export function buildCorpus(seed: bigint = CORPUS_SEED): Corpus {
  const r = rng(seed);
  const raw = edges();
  for (const [fn, { count, gen }] of Object.entries(RANDOM) as [OracleFn, { count: number; gen: Gen }][]) for (let i = 0; i < count; i++) raw.push([fn, gen(r)]);
  const cases = raw.map(([fn, a], id) => ({ id, fn, a }));
  const counts = {} as Record<OracleFn, number>;
  for (const c of cases) counts[c.fn] = (counts[c.fn] ?? 0) + 1;
  const fingerprint = createHash('sha256').update(cases.map(wire).join('\n')).digest('hex').slice(0, 16);
  return { cases, fingerprint, counts };
}

/**
 * The curve-port gate's view of `@merces/math`'s ported family (A-MATH-3): the functions under test, how each oracle
 * case runs on our side, and how an answer is compared with Stage 1's.
 *
 * The family is injectable (`PortedFamily`) so a test can hand the gate a deliberately wrong function and watch it fail.
 * Everything else the gate uses from `@merces/math` (`newVaultState`, `capPerUnit`, `paymentStable`, …) is Stage 1's own
 * object (re-exported), not under test here.
 */
import * as gateway from '@merces/math';
import { newTailState, newVaultState, type YearGrossRing } from '@merces/math';
import { PORTED } from '../steps/math.ts';

/** The ported names (`PORTED` in the math step). */
export type PortedName =
  | 'CURVE_BASE_DECIMALS'
  | 'CURVE_UNIT_SCALE'
  | 'unitScaleFor'
  | 'wadPerScaledUnit'
  | 'scaledCapWad'
  | 'scaledAmount'
  | 'isCappedScaled'
  | 'vaultReceiveGrossScaled'
  | 'tailReceiveScaled'
  | 'capRemainingScaled'
  | 'redemptionQuoteScaled'
  | 'p0PerUnit'
  | 'swapBaseMatchesOffer'
  | 'unitsOutstanding'
  | 'migrationFeeSplit'
  | 'walletTenderFits';

/** The ported family as the gate calls it: `@merces/math`'s by default. */
export type PortedFamily = Pick<typeof gateway, PortedName>;

export const OUR_FAMILY: PortedFamily = gateway;

/**
 * The oracle's entry points (`tools/stage1-oracle/src/main.rs`) and the ported names each one answers for. Every name
 * in `PORTED` must be answered for by at least one (the gate checks coverage).
 */
export const ORACLE_FNS = {
  constants: ['CURVE_BASE_DECIMALS', 'CURVE_UNIT_SCALE'],
  unit_scale_for: ['unitScaleFor'],
  wad_per_scaled_unit: ['wadPerScaledUnit'],
  scaled_cap_wad: ['scaledCapWad'],
  scaled_amount: ['scaledAmount'],
  is_capped: ['isCappedScaled'],
  receive_gross: ['vaultReceiveGrossScaled'],
  receive_tail: ['tailReceiveScaled'],
  cap_remaining: ['capRemainingScaled'],
  redemption_price: ['redemptionQuoteScaled'],
  p0_per_unit: ['p0PerUnit'],
  swap_base_matches_offer: ['swapBaseMatchesOffer'],
  units_outstanding: ['unitsOutstanding'],
  migration_fee_split: ['migrationFeeSplit'],
  wallet_tender_fits: ['walletTenderFits'],
} as const satisfies Record<string, readonly PortedName[]>;

export type OracleFn = keyof typeof ORACLE_FNS;

/** PORTED names no oracle entry point answers for (empty when the gate covers the whole family). */
export function uncovered(): string[] {
  const covered = new Set<string>(Object.values(ORACLE_FNS).flat());
  return PORTED.map((p) => p.name).filter((n) => !covered.has(n));
}

/** One slot of the 4-slot `year_gross` ring on the wire: `year` null for a slot never written. */
export interface WireSlot {
  year: number | null;
  gross_wad: bigint;
}

/** One case: the oracle's function name and its arguments (bigints travel as decimal strings). */
export interface OracleCase {
  id: number;
  fn: OracleFn;
  a: Record<string, unknown>;
}

/** An answer: Stage 1's or ours, in the oracle's shape. */
export type Answer = { ok: Record<string, unknown> } | { err: string } | { bad: string } | { panic: string };

/** JSON with bigints as decimal strings and object keys sorted: two answers agree when these strings are equal. */
export function canonical(v: unknown): string {
  return JSON.stringify(norm(v));
}

function norm(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  }
  return v;
}

/** One case as the oracle reads it. */
export function wire(c: OracleCase): string {
  return JSON.stringify({ id: c.id, fn: c.fn, a: c.a }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * A thrown error as the name of Stage 1's refusal: the port's errors start with Rust's `MathError` variant
 * (`scale.ts` `mathError`); Stage 1's vault and tail refuse zero units with `NoUnitsOutstanding`, as the Solana program
 * does before it calls merces-common (`common.rs:540-541`, `:600-601`). Anything else is ours alone and never agrees.
 */
export function refusal(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const kind = /^(Overflow|DivisionByZero|InvalidInput)\b/.exec(message)?.[1];
  if (kind) return kind;
  if (message === 'NoUnitsOutstanding') return 'NoUnitsOutstanding';
  return `not a Stage 1 refusal: ${e instanceof Error ? e.name : typeof e}: ${message}`;
}

/** Runs `f`, answering `{ok}` or the refusal. */
export function attempt(f: () => Record<string, unknown>): Answer {
  try {
    return { ok: f() };
  } catch (e) {
    return { err: refusal(e) };
  }
}

const ringIn = (slots: readonly WireSlot[]): YearGrossRing => slots.map((s) => ({ year: s.year, grossWad: s.gross_wad })) as unknown as YearGrossRing;
const ringOut = (ring: YearGrossRing): WireSlot[] => ring.map((s) => ({ year: s.year, gross_wad: s.grossWad }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = Record<string, any>;

/**
 * Our answer to one case: the ported function called as the product calls it, its result put in the oracle's shape.
 * The vault and tail run from a fresh state record holding the case's accumulators (not retired, not exhausted), so
 * `retired`/`exhausted` is the receipt's own `capped`.
 */
export function ours(fam: PortedFamily, c: OracleCase): Answer {
  const a = c.a as Args;
  return attempt(() => {
    switch (c.fn) {
      case 'constants':
        return { curve_base_decimals: fam.CURVE_BASE_DECIMALS, curve_unit_scale: fam.CURVE_UNIT_SCALE };
      case 'unit_scale_for':
        return { scale: fam.unitScaleFor(a.decimals) };
      case 'wad_per_scaled_unit':
        return { wad: fam.wadPerScaledUnit(a.unit_scale) };
      case 'scaled_cap_wad':
        return { cap_wad: fam.scaledCapWad(a.cap_per_unit, a.unit_scale) };
      case 'scaled_amount':
        return { amount: fam.scaledAmount(a.price, a.units, a.unit_scale) };
      case 'is_capped':
        return { capped: fam.isCappedScaled({ paidPerUnitWad: a.paid_per_unit_wad }, a.cap_per_unit, a.unit_scale) };
      case 'receive_gross': {
        const state = {
          ...newVaultState(),
          paidPerUnitWad: a.paid_per_unit_wad,
          netAccWad: a.net_acc_wad,
          carryWad: a.carry_wad,
          grossReceived: a.gross_received,
          feeCollected: a.fee_collected,
          refundedToIssuer: a.refunded_to_issuer,
          yearGross: ringIn(a.ring),
        };
        const { state: s, result: r } = fam.vaultReceiveGrossScaled(state, a.gross, a.units, a.cap_per_unit, a.unit_scale, a.fee_bps, a.year);
        return {
          accepted: r.accepted,
          refund: r.refund,
          inc_wad: r.incWad,
          fee: r.fee,
          net: r.netAdded,
          delta_acc_wad: r.deltaAccWad,
          carry_wad_out: r.carryWad,
          capped: r.retired,
          paid_per_unit_wad: s.paidPerUnitWad,
          net_acc_wad: s.netAccWad,
          gross_received: s.grossReceived,
          fee_collected: s.feeCollected,
          refunded_to_issuer: s.refundedToIssuer,
          ring: ringOut(s.yearGross),
        };
      }
      case 'receive_tail': {
        const state = { ...newTailState(a.tail_cap_per_unit), tailPaidPerUnitWad: a.tail_paid_per_unit_wad, tailAccWad: a.tail_acc_wad, tailCarryWad: a.tail_carry_wad };
        const { state: s, result: r } = fam.tailReceiveScaled(state, a.gross, a.units, a.fee_bps, a.unit_scale);
        return {
          accepted: r.accepted,
          refund: r.refund,
          inc_wad: s.tailPaidPerUnitWad - (a.tail_paid_per_unit_wad as bigint),
          fee: r.fee,
          net: r.accepted - r.fee,
          delta_acc_wad: r.deltaAccWad,
          carry_wad_out: s.tailCarryWad,
          capped: r.exhausted,
          tail_paid_per_unit_wad: s.tailPaidPerUnitWad,
          tail_acc_wad: s.tailAccWad,
        };
      }
      case 'cap_remaining':
        return { cap_remaining: fam.capRemainingScaled(a.cap_per_unit, a.paid_per_unit_wad, a.unit_scale) };
      case 'redemption_price': {
        const q = fam.redemptionQuoteScaled({
          p0: a.clearing_price,
          hurdleRateWad: a.hurdle_rate_wad,
          payoutMultipleK: a.payout_multiple_k,
          t: (a.now as bigint) - (a.settlement_ts as bigint),
          capPerUnit: a.cap_per_unit,
          paidPerUnitWad: a.paid_per_unit_wad,
          yearGross: ringIn(a.ring),
          unitsOutstanding: a.units,
          unitScale: a.unit_scale,
        });
        return { price: q.pRedeem, hurdle: q.pHurdle, d_avg: q.dAvg ?? 0n, cap_remaining: q.cRemaining, deposit: q.deposit, tail_cap_per_unit: q.tailCapPerUnit };
      }
      case 'p0_per_unit':
        return { p0: fam.p0PerUnit(a.migration_quote_threshold, a.swap_base_amount, a.token_decimal) };
      case 'swap_base_matches_offer':
        return { matches: fam.swapBaseMatchesOffer(a.swap_base_amount, a.units_offered, a.token_decimal) };
      case 'units_outstanding':
        return { units: fam.unitsOutstanding(a.supply, a.protocol_held) };
      case 'migration_fee_split': {
        const { partner, creator } = fam.migrationFeeSplit(a.migration_quote_threshold, a.fee_percentage, a.creator_fee_percentage);
        return { partner, creator };
      }
      case 'wallet_tender_fits':
        return { fits: fam.walletTenderFits(a.units_at_redemption, a.tendered_total, a.staked_total, a.amount) };
    }
  });
}

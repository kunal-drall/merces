import { MAX_RELEASE_TRANCHES, PARAMETER_BOUNDS, validateReleaseSchedule, wadToDecimal, walletCapUnitsAtAuction, type Parameters } from '@merces/math';
import { CURVE_ZERO_TERMS } from './curve.ts';
import type { SeriesTerms } from './events.ts';

/**
 * Stage 1's `create_series` rules on the terms, over the canonical terms, in Stage 1's order: a sealed-bid series by
 * Stage 1's reference simulator (SPEC §1.6, §3.2, §5.3; SIM:756-781), a curve series by the Solana registry, the only
 * chain with curve mode (`merces_registry` lib.rs:462-572; SPEC §9). The simulator's `createSeries` refuses with the
 * first violation; the terms service reports all of them per field, so a draft fails before a transaction is built.
 * The messages name the field and the protocol bound only: never the submitted value.
 */
export type TermsRule = 'ParameterOutOfBounds' | 'InvalidTerms' | 'InvalidReleaseSchedule' | CurveTermsRule;

/** The registry's curve-only rules (Solana error names; not in `@merces/sdk`'s `ERRORS`, lib.rs:470-485). */
export type CurveTermsRule = 'CurveThresholdZero' | 'CurveTermsNotZero' | 'CurveQuoteMintMismatch';

export interface TermsViolation {
  /** the canonical terms field (`SeriesTerms` key) */
  field: keyof SeriesTerms;
  /** Stage 1's error name for this rule (SPEC §11; the registry's for the curve-only rules) */
  stage1: TermsRule;
  /** a stable kebab-case rule id */
  code: string;
  /** value-free: the field and the protocol bound */
  message: string;
}

/** The terms the rules read. */
export type BoundedTerms = Pick<
  SeriesTerms,
  | 'capMultipleWad' | 'hurdleWad' | 'payoutMultipleK' | 'lockupSeconds' | 'walletCapBps' | 'auctionFeeBps' | 'payoutFeeBps'
  | 'nonRevealChargeBps' | 'commitDurationSeconds' | 'revealDurationSeconds'
  | 'dueDays' | 'graceDays' | 'formalNoticeDays' | 'unitsOffered' | 'reservePrice' | 'minimumRaise' | 'releaseSchedule' | 'raiseStyle'
  | 'stablecoin'
>;

type Unit = 'wad' | 'bps' | 'seconds' | 'days' | 'count';

/**
 * Stage 1's bounded terms (SIM:759-772, `PARAMETER_BOUNDS`) under our field names, in Stage 1's order, then the three
 * day counts Stage 1 fixes (min = max) as protocol parameters. The window durations and the window fee are not
 * canonical terms yet (S5), so their bounds are not checked here.
 *
 * `sealedOnly`: bounded on a sealed raise only. A curve series records 0 for the lockup, the wallet cap and the raise
 * durations (`CURVE_ZERO_TERMS`, CurveTermsNotZero), and Stage 1 bounds the protocol defaults in their place
 * (lib.rs:517-540), which are within the bounds; the non-reveal charge is an owner hold (not modelled) and stays
 * unchecked on a curve series, which has no auction to charge.
 */
const BOUNDED: readonly { field: keyof BoundedTerms; param: keyof Parameters; label: string; unit: Unit; sealedOnly?: true }[] = [
  { field: 'capMultipleWad', param: 'capMultipleWad', label: 'cap multiple', unit: 'wad' },
  { field: 'hurdleWad', param: 'hurdleRateWad', label: 'hurdle rate', unit: 'wad' },
  { field: 'payoutMultipleK', param: 'payoutMultipleK', label: 'payout multiple k', unit: 'count' },
  { field: 'lockupSeconds', param: 'lockupSeconds', label: 'lockup', unit: 'seconds', sealedOnly: true },
  { field: 'walletCapBps', param: 'walletCapBps', label: 'wallet cap', unit: 'bps', sealedOnly: true },
  { field: 'auctionFeeBps', param: 'auctionFeeBps', label: 'auction fee', unit: 'bps' },
  { field: 'payoutFeeBps', param: 'payoutFeeBps', label: 'payout fee', unit: 'bps' },
  // Stage 1's windowFeeBps comes here (S5)
  { field: 'nonRevealChargeBps', param: 'nonRevealChargeBps', label: 'non-reveal charge', unit: 'bps', sealedOnly: true },
  { field: 'commitDurationSeconds', param: 'commitDuration', label: 'commit duration', unit: 'seconds', sealedOnly: true },
  { field: 'revealDurationSeconds', param: 'revealDuration', label: 'reveal duration', unit: 'seconds', sealedOnly: true },
  // Stage 1's windowCommitDuration and windowRevealDuration come here (S5)
  { field: 'dueDays', param: 'reportDueDays', label: 'report due days', unit: 'days' },
  { field: 'graceDays', param: 'graceDays', label: 'grace days', unit: 'days' },
  { field: 'formalNoticeDays', param: 'formalNoticeDays', label: 'formal notice days', unit: 'days' },
];

function boundMessage(label: string, unit: Unit, min: bigint, max: bigint): string {
  const fmt = (x: bigint) => (unit === 'wad' ? wadToDecimal(x) : x.toString());
  const suffix = unit === 'bps' ? ' bps' : unit === 'seconds' ? ' seconds' : unit === 'days' ? ' days' : '';
  return min === max ? `${label} is fixed by Stage 1 at ${fmt(min)}${suffix}` : `${label} must be between ${fmt(min)} and ${fmt(max)}${suffix}`;
}

/** Stage 1's `validateReleaseSchedule` rule names, as rule ids and value-free messages. */
const SCHEDULE_RULES: Record<string, { code: string; message: string }> = {
  empty: { code: 'empty', message: 'release schedule needs at least one tranche' },
  too_many_tranches: { code: 'too-many-tranches', message: `release schedule has more than ${MAX_RELEASE_TRANCHES} tranches` },
  bps_out_of_range: { code: 'bps-range', message: 'each release tranche must be between 0 and 10000 bps' },
  negative_offset: { code: 'negative-offset', message: 'release tranche offsets cannot be negative' },
  offsets_decrease: { code: 'offsets-decrease', message: 'release tranche offsets must not decrease' },
  bps_sum_not_10000: { code: 'bps-sum', message: 'release schedule must sum to 10000 bps' },
};

/** Each bounded parameter within PARAMETER_BOUNDS (SIM:759-777; registry lib.rs:517-561), `sealedOnly` ones on a sealed raise. */
function boundViolations(t: BoundedTerms, curve: boolean): TermsViolation[] {
  const out: TermsViolation[] = [];
  for (const { field, param, label, unit, sealedOnly } of BOUNDED) {
    if (sealedOnly && curve) continue;
    const b = PARAMETER_BOUNDS[param];
    const v = BigInt(t[field] as string | number);
    if (v < b.min || v > b.max) out.push({ field, stage1: 'ParameterOutOfBounds', code: 'out-of-bounds', message: boundMessage(label, unit, b.min, b.max) });
  }
  return out;
}

/**
 * Stage 1's `validateReleaseSchedule` (non-empty, ≤ 24 tranches, bps in range, offsets non-negative and non-decreasing,
 * bps summing to 10000); a rule broken by several tranches is reported once.
 */
function scheduleViolations(t: BoundedTerms): TermsViolation[] {
  const schedule = t.releaseSchedule.map((r) => ({ atOffsetSeconds: BigInt(r.afterSeconds), bps: r.bps }));
  return [...new Set(validateReleaseSchedule(schedule))].map((rule) => {
    const r = SCHEDULE_RULES[rule] ?? { code: rule, message: 'release schedule is invalid' };
    return { field: 'releaseSchedule', stage1: 'InvalidReleaseSchedule', code: r.code, message: r.message };
  });
}

/** What each curve zero is called in a message (`CURVE_ZERO_TERMS`, in Stage 1's order). */
const CURVE_ZERO_LABEL: Record<(typeof CURVE_ZERO_TERMS)[number], string> = {
  lockupSeconds: 'lockup', walletCapBps: 'wallet cap', commitDurationSeconds: 'commit duration', revealDurationSeconds: 'reveal duration',
};

/** Every Stage 1 `create_series` rule the terms break, in Stage 1's order (empty when they are valid). */
export function seriesTermsViolations(t: BoundedTerms): TermsViolation[] {
  const out: TermsViolation[] = [];
  const units = BigInt(t.unitsOffered);
  const reserve = BigInt(t.reservePrice);
  const positive = (field: 'unitsOffered' | 'reservePrice', label: string): TermsViolation => ({ field, stage1: 'InvalidTerms', code: 'positive', message: `${label} must be positive` });
  if (t.raiseStyle === 'curve') {
    // the Solana registry's order (lib.rs:462-572): units offered and the start price at least 1 (UnitsOfferedZero,
    // ReservePriceZero: InvalidTerms in Stage 1's reference names)
    if (units < 1n) out.push(positive('unitsOffered', 'units offered'));
    if (reserve < 1n) out.push(positive('reservePrice', 'reserve price'));
    // the minimum raise is the curve's migration threshold X: at least 1 (CurveThresholdZero); "minimum raise ≤
    // reserve × units" is a sealed-bid rule (the curve completes at exactly X or never)
    if (BigInt(t.minimumRaise) < 1n) out.push({ field: 'minimumRaise', stage1: 'CurveThresholdZero', code: 'positive', message: 'minimum raise (the curve\'s migration threshold) must be positive' });
    // no auction, lockup or wallet cap: those terms are 0 (CurveTermsNotZero), one violation per field
    for (const field of CURVE_ZERO_TERMS) {
      if (Number(t[field]) !== 0) out.push({ field, stage1: 'CurveTermsNotZero', code: 'curve-zero', message: `${CURVE_ZERO_LABEL[field]} must be 0 on a curve series` });
    }
    // the curve quotes in USDC (the registry's curve quote mint; CurveQuoteMintMismatch)
    if (t.stablecoin !== 'USDC') out.push({ field: 'stablecoin', stage1: 'CurveQuoteMintMismatch', code: 'curve-quote-usdc', message: 'a curve raise is quoted in USDC' });
    // the release schedule (InvalidReleaseSchedule), then the bounds on the rest; no wallet-cap rule (lib.rs:564-570)
    out.push(...scheduleViolations(t), ...boundViolations(t, true));
    return out;
  }
  // Stage 1's reference simulator's order. SIM:759-777: each bounded parameter within PARAMETER_BOUNDS
  out.push(...boundViolations(t, false));
  // SIM:778: units offered and reserve price at least 1, the minimum raise reachable
  if (units < 1n) out.push(positive('unitsOffered', 'units offered'));
  if (reserve < 1n) out.push(positive('reservePrice', 'reserve price'));
  if (BigInt(t.minimumRaise) > reserve * units) out.push({ field: 'minimumRaise', stage1: 'InvalidTerms', code: 'unreachable', message: 'minimum raise exceeds units × reserve price' });
  // SIM:779: Stage 1's walletCapUnitsAtAuction (floor(units offered × wallet cap bps / 10000)) is at least one unit
  if (units >= 1n && t.walletCapBps >= 0 && walletCapUnitsAtAuction(units, t.walletCapBps) < 1n) {
    out.push({ field: 'unitsOffered', stage1: 'InvalidTerms', code: 'wallet-cap-below-one-unit', message: 'the wallet cap (units offered × wallet cap bps / 10000, rounded down) must be at least one unit' });
  }
  // SIM:780-781: the release schedule
  out.push(...scheduleViolations(t));
  return out;
}

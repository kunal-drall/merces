import { MAX_RELEASE_TRANCHES, PARAMETER_BOUNDS, validateReleaseSchedule, wadToDecimal, walletCapUnitsAtAuction, type Parameters } from '@merces/math';
import type { SeriesTerms } from './events.ts';

/**
 * Stage 1's `create_series` rules on the terms (SPEC §1.6, §3.2, §5.3; Stage 1 SIM:756-781), in Stage 1's order, over
 * the canonical terms. The simulator's `createSeries` refuses with the first violation; the terms service reports all
 * of them per field, so a draft fails before a transaction is built. The messages name the field and the protocol
 * bound only: never the submitted value.
 */
export type TermsRule = 'ParameterOutOfBounds' | 'InvalidTerms' | 'InvalidReleaseSchedule';

export interface TermsViolation {
  /** the canonical terms field (`SeriesTerms` key) */
  field: keyof SeriesTerms;
  /** Stage 1's error name for this rule (SPEC §11) */
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
>;

type Unit = 'wad' | 'bps' | 'seconds' | 'days' | 'count';

/**
 * Stage 1's bounded terms (SIM:759-772, `PARAMETER_BOUNDS`) under our field names, in Stage 1's order, then the three
 * day counts Stage 1 fixes (min = max) as protocol parameters. The window durations and the window fee are not
 * canonical terms yet (S5), so their bounds are not checked here.
 *
 * `sealedOnly`: the non-reveal charge and the raise durations are bounded for a sealed raise only. Stage 1 requires 0
 * for them on a curve series (SPEC v1.1.2 §9), which the canonical model does not apply before S5, so a curve series
 * carries them unchecked.
 */
const BOUNDED: readonly { field: keyof BoundedTerms; param: keyof Parameters; label: string; unit: Unit; sealedOnly?: true }[] = [
  { field: 'capMultipleWad', param: 'capMultipleWad', label: 'cap multiple', unit: 'wad' },
  { field: 'hurdleWad', param: 'hurdleRateWad', label: 'hurdle rate', unit: 'wad' },
  { field: 'payoutMultipleK', param: 'payoutMultipleK', label: 'payout multiple k', unit: 'count' },
  { field: 'lockupSeconds', param: 'lockupSeconds', label: 'lockup', unit: 'seconds' },
  { field: 'walletCapBps', param: 'walletCapBps', label: 'wallet cap', unit: 'bps' },
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

/** Every Stage 1 `create_series` rule the terms break, in Stage 1's order (empty when they are valid). */
export function seriesTermsViolations(t: BoundedTerms): TermsViolation[] {
  const out: TermsViolation[] = [];
  // SIM:759-777: each bounded parameter within PARAMETER_BOUNDS (the raise's own on a sealed raise only)
  for (const { field, param, label, unit, sealedOnly } of BOUNDED) {
    if (sealedOnly && t.raiseStyle !== 'sealed') continue;
    const b = PARAMETER_BOUNDS[param];
    const v = BigInt(t[field] as string | number);
    if (v < b.min || v > b.max) out.push({ field, stage1: 'ParameterOutOfBounds', code: 'out-of-bounds', message: boundMessage(label, unit, b.min, b.max) });
  }
  // SIM:778: units offered and reserve price at least 1, the minimum raise reachable
  const units = BigInt(t.unitsOffered);
  const reserve = BigInt(t.reservePrice);
  if (units < 1n) out.push({ field: 'unitsOffered', stage1: 'InvalidTerms', code: 'positive', message: 'units offered must be positive' });
  if (reserve < 1n) out.push({ field: 'reservePrice', stage1: 'InvalidTerms', code: 'positive', message: 'reserve price must be positive' });
  if (BigInt(t.minimumRaise) > reserve * units) out.push({ field: 'minimumRaise', stage1: 'InvalidTerms', code: 'unreachable', message: 'minimum raise exceeds units × reserve price' });
  // SIM:779: Stage 1's walletCapUnitsAtAuction (floor(units offered × wallet cap bps / 10000)) is at least one unit
  if (units >= 1n && t.walletCapBps >= 0 && walletCapUnitsAtAuction(units, t.walletCapBps) < 1n) {
    out.push({ field: 'unitsOffered', stage1: 'InvalidTerms', code: 'wallet-cap-below-one-unit', message: 'the wallet cap (units offered × wallet cap bps / 10000, rounded down) must be at least one unit' });
  }
  // SIM:780-781: Stage 1's validateReleaseSchedule (non-empty, ≤ 24 tranches, bps in range, offsets non-negative and
  // non-decreasing, bps summing to 10000); a rule broken by several tranches is reported once
  const schedule = t.releaseSchedule.map((r) => ({ atOffsetSeconds: BigInt(r.afterSeconds), bps: r.bps }));
  for (const rule of new Set(validateReleaseSchedule(schedule))) {
    const r = SCHEDULE_RULES[rule] ?? { code: rule, message: 'release schedule is invalid' };
    out.push({ field: 'releaseSchedule', stage1: 'InvalidReleaseSchedule', code: r.code, message: r.message });
  }
  return out;
}

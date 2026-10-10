import { describe, expect, it } from 'vitest';
import * as sdk from '@merces/sdk';
import * as ref from '@merces/reference';
import * as gateway from '../src/index.ts';
import {
  DAY,
  PAYMENT_RANGE_ERROR,
  SeriesStatus,
  WAD,
  beginSettlement,
  capRemaining,
  claimsFor,
  countdown,
  deadlineSeconds,
  deriveStatus,
  finalizeSettlement,
  findClearingPrice,
  formalNoticeDue,
  fromPid,
  graceSeconds,
  interim,
  isBidValid,
  isPausedAt,
  newYearGross,
  parsePeriod,
  paymentStable,
  periodFrom,
  periodOf,
  periodsBetween,
  processBid,
  projectDeadlines,
  ratePerUnit,
  redemptionQuote,
  requiredEscrow,
  standingOf,
  statusParamsOf,
  tallyBids,
  toPid,
  wadFromDecimal,
  wadToDecimal,
  walletCapUnitsAtAuction,
  type AuctionRules,
  type LedgerClock,
  type Pause,
  type RevealedBid,
  type SettledState,
} from '../src/index.ts';

/**
 * Pins that moved with Stage 1 in S2 carry a cause code:
 *  - S2-G: `@merces/math` re-exports Stage 1's auction family (SPEC v1.1 §5.1–§5.2: the auction's wallet cap, the
 *    required escrow, validity at reveal, begin/tally/finalize, per-bid processing, honest claims and the clearing
 *    price); the interim auction family is retired (its callers moved to Stage 1's steps), and the interim cap left
 *    under `interim` is the window and curve cap (S5).
 *  - S3-NC: a curve raise has no cap at any stage (owner; Stage 1 stores 0), so the interim cap is the window cap only.
 *  - S3-M: a segregated family is ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3): the unit scale, the
 *    vault, tail and redemption at a scale, and curve mode's arithmetic. They are ours, not Stage 1 objects; at scale 1
 *    the scale-aware ones return Stage 1's own results (`curve.test.ts`).
 */

// ---------------------------------------------------------------- the gateway

const SDK_REEXPORTS = [
  'WAD', 'BPS_DENOMINATOR', 'mulDiv', 'mulDivCeil', 'ceilDiv', 'wadMul', 'wadDiv', 'bpsOf',
  'DAY', 'YEAR', 'periodStart', 'periodEnd', 'quarterIndex', 'yearOf', 'periodLabel', 'tradingDaysInPeriod',
  'unpaused', 'isPausedAt', 'pausedWithin',
  'newYearGross', 'settlementYear', 'yearGrossAdd', 'yearGrossGet',
  'DEFAULT_PARAMETERS', 'PARAMETER_BOUNDS', 'parametersFromStrings', 'SeriesStatus', 'RaiseState', 'TIER_FLAG', 'tierEnabled',
  'ERRORS', 'ERROR_ALIASES', 'isErrorName',
  'BN254_FR', 'assertField', 'poseidon2', 'poseidon5', 'CURRENCY_CODES', 'INDEXING_RULES',
  'U64_MAX', 'ZERO_INCOME_COMMITMENT', 'bytes32ToField', 'fieldToBytes32',
] as const;
/** Stage 1's commitment helpers, renamed: they return the field element (`@merces/domain` returns the 0x-hex). */
const SDK_RENAMED = { termsCommitmentField: 'termsCommitment', incomeCommitmentField: 'incomeCommitment', routerIncomeCommitmentField: 'routerIncomeCommitment' } as const;
const REFERENCE_REEXPORTS = [
  'isTerminal', 'deadlineSeconds', 'graceSeconds', 'noticeSeconds', 'countdown', 'nextExpectedPeriod', 'earliestUnpaid', 'deriveStatus', 'isLateUnderlying', 'lateDays', 'lateAccrual', 'formalNoticeDue', 'pauseApprovalError',
  'newVaultState', 'capPerUnit', 'capEffWad', 'isCapped', 'vaultReceiveGross', 'settleHolderDelta', 'accumulate',
  'hurdlePrice', 'averageAnnualGross', 'redemptionQuote', 'newTailState', 'tailReceive', 'newFinalState', 'finalDistribute',
  'MAX_RELEASE_TRANCHES', 'validateReleaseSchedule', 'trancheAmounts', 'vested', 'releasable',
  'owedYtd', 'paymentUsd',
  // cause S2-G: Stage 1's auction family
  'walletCapUnitsAtAuction', 'requiredEscrow', 'isBidValid', 'beginSettlement', 'tallyBids', 'isClearingPriceValid', 'finalizeSettlement', 'marginalAllocation', 'processBid', 'claimsFor', 'findClearingPrice',
] as const;

/** cause S3-M: ported from merces-common @1bfc66b (A-MATH-3); `stage1:sync` lists them as ported. */
const PORTED = [
  'CURVE_BASE_DECIMALS', 'CURVE_UNIT_SCALE', 'unitScaleFor', 'wadPerScaledUnit', 'scaledCapWad', 'scaledAmount',
  'isCappedScaled', 'vaultReceiveGrossScaled', 'tailReceiveScaled', 'capRemainingScaled', 'redemptionQuoteScaled',
  'p0PerUnit', 'swapBaseMatchesOffer', 'unitsOutstanding', 'migrationFeeSplit', 'walletTenderFits',
] as const;

describe('@merces/math gateway', () => {
  it('re-exports Stage 1\'s own objects, not copies', () => {
    const gw = gateway as unknown as Record<string, unknown>;
    for (const n of SDK_REEXPORTS) expect(gw[n], n).toBe((sdk as unknown as Record<string, unknown>)[n]);
    expect(gw.pidAt).toBe(sdk.periodOf);
    for (const [ours, theirs] of Object.entries(SDK_RENAMED)) expect(gw[ours], ours).toBe((sdk as unknown as Record<string, unknown>)[theirs]);
    for (const n of REFERENCE_REEXPORTS) expect(gw[n], n).toBe((ref as unknown as Record<string, unknown>)[n]);
  });
  it('exports exactly Stage 1, our helpers, the ported curve family and `interim` (no swap machinery, no other top-level interim name)', () => {
    const ours = ['periodOf', 'periodOfPid', 'periodFrom', 'parsePeriod', 'periodsBetween', 'toPid', 'fromPid', 'wadFromDecimal', 'wadToDecimal', 'utcDayIndex', 'ratePerUnit', 'paymentStable', 'PAYMENT_RANGE_ERROR', 'statusParamsOf', 'projectDeadlines', 'standingOf', 'capRemaining'];
    const keys = Object.keys(gateway);
    // cause S3-M: the ported family (16 names) sits beside Stage 1's, and none of it is a Stage 1 object
    expect([...keys].sort()).toEqual([...SDK_REEXPORTS, 'pidAt', ...Object.keys(SDK_RENAMED), ...REFERENCE_REEXPORTS, ...ours, ...PORTED, 'interim'].sort());
    const stage1 = new Set<unknown>([...Object.values(sdk), ...Object.values(ref)].filter((v) => typeof v === 'function'));
    for (const n of PORTED) {
      expect(n in sdk || n in ref, n).toBe(false);
      expect(stage1.has((gateway as unknown as Record<string, unknown>)[n]), n).toBe(false);
    }
    // Stage 1's positional quarterPayment (θ third) and Stage 1's `walletCapUnits` (the redemption-window cap, S5) are
    // deliberately not re-exported; the auction's cap is `walletCapUnitsAtAuction` (cause S2-G)
    expect(keys).not.toContain('quarterPayment');
    expect(keys).not.toContain('walletCapUnits');
    expect(gateway.walletCapUnitsAtAuction).toBe(ref.walletCapUnitsAtAuction);
    expect(gateway.redemptionQuote).toBe(ref.redemptionQuote);
  });
  it('`interim` keeps exactly the window cap (S5) and the FX family (S5)', () => {
    // cause S2-G: the interim auction family (clearing, deposit, fee) is retired; the sealed raise runs Stage 1's
    expect(Object.keys(interim).sort()).toEqual([
      // window cap (S5); cause S3-NC: no longer the curve's (a curve raise has no cap)
      'walletCapUnits',
      // FX (S5)
      'quarterAverageRate', 'coverageOk', 'deviationBps', 'withinBand', 'pythToWad',
    ].sort());
    // the interim cap is not Stage 1's (S5 moves the window to Stage 1's)
    expect(interim.walletCapUnits).not.toBe((ref as unknown as Record<string, unknown>).walletCapUnits);
  });
});

// ---------------------------------------------------------------- periods

describe('period codec on Stage 1 periods', () => {
  it('maps "YYYYQn" to Stage 1 period ids with Stage 1 boundaries, 2026Q1 to 2030Q4', () => {
    const q1 = parsePeriod('2026Q1');
    expect(q1).toEqual({ id: '2026Q1', pid: 8104, year: 2026, quarter: 1, start: 1_767_225_600, end: 1_775_001_600, days: 90 });
    expect(toPid('2026Q1')).toBe(8104);
    expect(fromPid(8104)).toBe('2026Q1');
    for (let year = 2026; year <= 2030; year++) {
      for (const quarter of [1, 2, 3, 4] as const) {
        const id = `${year}Q${quarter}`;
        const pid = sdk.periodId(year, quarter);
        const p = parsePeriod(id);
        expect(p.pid).toBe(pid);
        expect(toPid(id)).toBe(pid);
        expect(fromPid(pid)).toBe(id);
        expect(sdk.periodLabel(pid)).toBe(id);
        expect(BigInt(p.start)).toBe(sdk.periodStart(pid));
        expect(BigInt(p.end)).toBe(sdk.periodEnd(pid));
        expect(BigInt(p.days)).toBe(sdk.daysInPeriod(pid));
        expect(periodFrom(year, quarter)).toEqual(p);
        expect(periodOf(p.start)).toEqual(p);
        expect(periodOf(p.end - 1)).toEqual(p);
        expect(periodOf(p.end).pid).toBe(pid + 1);
        expect(sdk.periodOf(BigInt(p.start))).toBe(pid);
      }
    }
    expect(periodsBetween(parsePeriod('2026Q1').start, parsePeriod('2030Q4').end).map((p) => p.pid)).toEqual(Array.from({ length: 20 }, (_, i) => 8104 + i));
    expect(() => toPid('2026Q5')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- rate, payment, cap

const hasDigit = (f: () => unknown): boolean => {
  try {
    f();
  } catch (e) {
    return /\d/.test((e as Error).message);
  }
  throw new Error('did not throw');
};

describe('ratePerUnit bounds (SPEC §1.5)', () => {
  it('derives r = floor(s / N) and enforces r < 2^64 and r × N ≤ WAD', () => {
    expect(ratePerUnit(wadFromDecimal('0.10'), 1_000n)).toBe(100_000_000_000_000n);
    expect(ratePerUnit(WAD, 3n)).toBe(333_333_333_333_333_333n);
    expect(ratePerUnit(WAD, 1n)).toBe(WAD); // r × N = WAD exactly: allowed
    expect(() => ratePerUnit(WAD + 1n, 1n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(2n * WAD, 3n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(-1n, 3n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(WAD, 0n)).toThrow(RangeError);
    for (const f of [() => ratePerUnit(WAD + 1n, 1n), () => ratePerUnit(-5n, 7n), () => ratePerUnit(WAD, 0n)]) expect(hasDigit(f)).toBe(false);
  });
});

describe('paymentStable wraps Stage 1 paymentUsd', () => {
  const base = { rWad: ratePerUnit(wadFromDecimal('0.10'), 1_000n), unitsOutstanding: 1_000n, theta: 60_000_000_000n, priorIncomeYtd: 50_000_000_000n, incomeYtd: 75_000_000_000n, fxAvgWad: WAD };
  it('is Stage 1\'s payment', () => {
    expect(paymentStable(base)).toBe(ref.paymentUsd(base));
    expect(paymentStable(base)).toBe(1_500_000_000n);
    expect(paymentStable({ ...base, fxAvgWad: wadFromDecimal('1.08') })).toBe(1_620_000_000n);
  });
  it('rethrows every Stage 1 error without the figures', () => {
    // Stage 1's own message names the value: income figures must never reach an error
    expect(() => ref.paymentUsd({ ...base, incomeYtd: 2n ** 64n })).toThrow(/18446744073709551616/);
    const bad = [{ ...base, incomeYtd: 2n ** 64n }, { ...base, incomeYtd: 1n, priorIncomeYtd: 2n }, { ...base, theta: -1n }, { ...base, fxAvgWad: 2n ** 70n }];
    for (const a of bad) {
      expect(() => paymentStable(a)).toThrow(new RangeError(PAYMENT_RANGE_ERROR));
      expect(hasDigit(() => paymentStable(a))).toBe(false);
    }
  });
});

describe('capRemaining (display) equals Stage 1 C_remaining', () => {
  it('on a deterministic grid, rounding the paid amount up', () => {
    const caps = [0n, 1n, 25_000_000n, 262_500_002n];
    let n = 0;
    for (const cap of caps) {
      const paids = [0n, 1n, WAD - 1n, WAD, WAD + 1n, cap * WAD - 1n, cap * WAD, cap * WAD + 1n, (cap * WAD) / 3n, (cap * WAD * 7n) / 9n + 13n].filter((x) => x >= 0n);
      for (const paid of paids) {
        const q = redemptionQuote({ p0: 10_000_000n, hurdleRateWad: wadFromDecimal('0.08'), payoutMultipleK: 5, t: 0n, capPerUnit: cap, paidPerUnitWad: paid, yearGross: newYearGross(), unitsOutstanding: 1n });
        expect(capRemaining(cap, paid), `${cap}/${paid}`).toBe(q.cRemaining);
        n++;
      }
    }
    expect(n).toBe(39);
    // a fraction of a base unit paid counts as a whole one (cap − floor(paid / WAD) would show 24,999,999)
    expect(capRemaining(25_000_000n, WAD + 1n)).toBe(24_999_998n);
  });
});

// ---------------------------------------------------------------- status

const params = statusParamsOf({ dueDays: 30, graceDays: 15, formalNoticeDays: 90, hurdleWad: wadFromDecimal('0.08') });
const clockOf = (pid: number, pauses: Pause[]): LedgerClock => ({ status: SeriesStatus.OnTime, firstPeriod: pid, lastAcceptedPeriod: null, openDuePeriod: null, openDueAmount: 0n, pauses, trueupDue: 0n, trueupAttestedAt: 0n });
const d = (n: number) => BigInt(n) * DAY;

describe('statusParamsOf', () => {
  it('maps series terms onto Stage 1 StatusParams', () => {
    expect(params).toEqual({ reportDueDays: 30, graceDays: 15, formalNoticeDays: 90, trueupDays: 60, hurdleRateWad: 80_000_000_000_000_000n });
    expect(statusParamsOf({ dueDays: 30, graceDays: 15, formalNoticeDays: 90, hurdleWad: '80000000000000000', trueupDays: 60 }).hurdleRateWad).toBe(80_000_000_000_000_000n);
  });
});

describe('projectDeadlines against Stage 1 countdown, deriveStatus and formalNoticeDue', () => {
  // pause layouts relative to the period end E; `now` marks which pauses are recorded (and which one is open)
  const layouts: { name: string; pauses: (e: bigint) => Pause[]; now: (e: bigint) => bigint; expect: [number, number, number] }[] = [
    { name: 'no pause', pauses: () => [], now: (e) => e + d(1), expect: [30, 45, 90] },
    { name: 'one recorded pause before the due date', pauses: (e) => [{ start: e + d(10), end: e + d(25) }], now: (e) => e + d(26), expect: [45, 60, 105] },
    { name: 'a recorded pause straddling the period end', pauses: (e) => [{ start: e - d(5), end: e + d(3) }], now: (e) => e + d(4), expect: [33, 48, 93] },
    { name: 'a recorded pause starting exactly at the due instant', pauses: (e) => [{ start: e + d(30), end: e + d(40) }], now: (e) => e + d(41), expect: [40, 55, 100] },
    { name: 'an open pause during grace (counted to its approved end)', pauses: (e) => [{ start: e + d(40), end: e + d(70) }], now: (e) => e + d(50), expect: [30, 75, 120] },
    { name: 'two recorded pauses', pauses: (e) => [{ start: e + d(2), end: e + d(4) }, { start: e + d(50), end: e + d(53) }], now: (e) => e + d(60), expect: [32, 47, 95] },
  ];
  for (const pid of [8104, 8105, 8107, 8111]) {
    for (const l of layouts) {
      it(`${fromPid(pid)}: ${l.name}`, () => {
        const e = sdk.periodEnd(pid);
        const pauses = l.pauses(e);
        const clock = clockOf(pid, pauses);
        const { dueAt, graceEndsAt, formalNoticeAt } = projectDeadlines(pid, pauses, l.now(e), params);
        expect([dueAt, graceEndsAt, formalNoticeAt]).toEqual(l.expect.map((x) => e + d(x)));
        for (const t of [dueAt, dueAt + 1n, graceEndsAt, graceEndsAt + 1n, formalNoticeAt - 1n, formalNoticeAt]) expect(isPausedAt(pauses, t)).toBe(false);
        // formal notice turns due exactly at formalNoticeAt
        expect(formalNoticeDue(pid, clock, formalNoticeAt, params)).toBe(true);
        expect(formalNoticeDue(pid, clock, formalNoticeAt - 1n, params)).toBe(false);
        // the countdown crosses the bounds exactly there
        expect(countdown(pid, clock, dueAt)).toBe(deadlineSeconds(params));
        expect(countdown(pid, clock, graceEndsAt)).toBe(graceSeconds(params));
        // Stage 1's derived status at the projected instants
        expect(deriveStatus(clock, dueAt, params)).toBe(SeriesStatus.OnTime);
        expect(deriveStatus(clock, dueAt + 1n, params)).toBe(SeriesStatus.InGrace);
        expect(deriveStatus(clock, graceEndsAt, params)).toBe(SeriesStatus.InGrace);
        expect(deriveStatus(clock, graceEndsAt + 1n, params)).toBe(SeriesStatus.Late);
        // and the per-period standing
        expect(standingOf(pid, clock, dueAt, params, false)).toBe('OnTime');
        expect(standingOf(pid, clock, dueAt + 1n, params, false)).toBe('InGrace');
        expect(standingOf(pid, clock, graceEndsAt, params, false)).toBe('InGrace');
        expect(standingOf(pid, clock, graceEndsAt + 1n, params, false)).toBe('Late');
        expect(standingOf(pid, clock, formalNoticeAt - 1n, params, false)).toBe('Late');
        expect(standingOf(pid, clock, formalNoticeAt, params, false)).toBe('FormalNoticeDue');
        expect(standingOf(pid, clock, formalNoticeAt, params, true)).toBe('OnTime');
        expect(standingOf(pid, clock, e - 1n, params, false)).toBe('NotDue');
        for (const p of pauses) if (p.start >= e) expect(standingOf(pid, clock, p.start, params, false)).toBe('Deferred');
      });
    }
  }
  it('assumes no pause beyond those recorded as of `now`', () => {
    const e = sdk.periodEnd(8104);
    const later = [{ start: e + d(20), end: e + d(30) }];
    expect(projectDeadlines(8104, later, e + d(10), params)).toEqual(projectDeadlines(8104, [], e + d(10), params));
    expect(projectDeadlines(8104, later, e + d(20), params).dueAt).toBe(e + d(40));
  });
});

// ---------------------------------------------------------------- Stage 1's auction family (S2)

describe('Stage 1 auction family (SPEC v1.1 §5.1–§5.2; cause S2-G)', () => {
  const usdc = (n: number) => BigInt(n) * 1_000_000n;
  // the harness's default raise (`defaultTerms` and `runRaise` in packages/simulator/src/harness.ts): 500 units, reserve
  // 8 USDC, minimum raise 4,000, wallet cap 20% (100 units), auction fee 1%, non-reveal charge 1% (the harness's own rate;
  // cause NRC, was 0 under the S2 hold: a revealed bid, valid or not, never pays it)
  const rules: AuctionRules = { unitsOffered: 500n, reservePrice: usdc(8), minRaise: usdc(4_000), walletCapBps: 2000, auctionFeeBps: 100, nonRevealChargeBps: 100 };
  const revealed = (price: bigint, quantity: bigint, revealIndex: number): RevealedBid => {
    const escrow = requiredEscrow(price, quantity, rules.auctionFeeBps);
    return { price, quantity, escrow, valid: isBidValid(price, quantity, escrow, rules), revealIndex };
  };
  // five backers bid 12 / 11 / 10 / 10 / 9 USDC × 100 units, each escrowing exactly price × quantity plus the 1% fee
  const bids = [12, 11, 10, 10, 9].map((p, i) => revealed(usdc(p), 100n, i));

  it('the default harness raise: clears at 9 USDC, sells out, takes 9 USDC of fee per bid and refunds 303/202/101/101/0', () => {
    // why most `runRaise` pins survived S2: Stage 1 settles this raise at the figures the retired interim clearing gave
    // (from Stage 1's own Simulator: every backer pays 909 USDC for 100 units)
    expect(walletCapUnitsAtAuction(rules.unitsOffered, rules.walletCapBps)).toBe(100n);
    expect(bids.map((b) => b.escrow)).toEqual([1_212, 1_111, 1_010, 1_010, 909].map(usdc));
    expect(bids.every((b) => b.valid)).toBe(true);
    const price = findClearingPrice(bids, rules.unitsOffered);
    expect(price).toBe(usdc(9));
    const claims = claimsFor(bids, price!);
    expect(claims).toEqual({ qAboveClaim: 400n, qAtClaim: 100n });
    const proposal = beginSettlement(rules.unitsOffered, price!, claims.qAboveClaim, claims.qAtClaim);
    expect(proposal.rClaim).toBe(100n);
    const tally = tallyBids(bids, proposal);
    expect(tally).toEqual({ qAbove: 400n, qAt: 100n, allocSum: 100n, minValidPrice: usdc(9), talliedCount: 5 });
    expect(finalizeSettlement(tally, 5, rules, proposal)).toEqual({ kind: 'settled', clearingPrice: usdc(9), R: 100n, qAt: 100n, qAbove: 400n, unitsSold: 500n, proceeds: usdc(4_500) });
    const settled: SettledState = { failed: false, clearingPrice: usdc(9), R: 100n, qAt: 100n };
    const outcomes = bids.map((b) => processBid({ ...b, revealed: true }, settled, rules));
    for (const o of outcomes) expect(o).toMatchObject({ alloc: 100n, cost: usdc(900), fee: usdc(9), charge: 0n });
    expect(outcomes.map((o) => o.pendingRefund)).toEqual([303, 202, 101, 101, 0].map(usdc));
  });

  it('a bid above the wallet cap is invalid (not trimmed to the cap): it is tallied for nothing and refunded in full', () => {
    // 300 units on a 100-unit cap, fully escrowed: invalid at reveal (the interim clearing trimmed it to the cap)
    const over = revealed(usdc(12), 300n, 5);
    expect(over.valid).toBe(false);
    expect(isBidValid(usdc(12), 100n, requiredEscrow(usdc(12), 100n, 100), rules)).toBe(true);
    expect(isBidValid(usdc(12), 101n, requiredEscrow(usdc(12), 101n, 100), rules)).toBe(false);
    // the clearing is the default raise's: the invalid bid counts toward `talliedCount` only
    const all = [...bids, over];
    expect(findClearingPrice(all, rules.unitsOffered)).toBe(usdc(9));
    expect(tallyBids(all, beginSettlement(rules.unitsOffered, usdc(9), 400n, 100n))).toEqual({ qAbove: 400n, qAt: 100n, allocSum: 100n, minValidPrice: usdc(9), talliedCount: 6 });
    const settled: SettledState = { failed: false, clearingPrice: usdc(9), R: 100n, qAt: 100n };
    expect(processBid({ ...over, revealed: true }, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: usdc(3_636), charge: 0n });
  });

  it('the auction wallet cap has no minimum of one unit (the interim cap rounded up to one)', () => {
    expect(walletCapUnitsAtAuction(5n, 1000)).toBe(0n);
    expect(interim.walletCapUnits(5n, 1_000n)).toBe(1n);
    // so no bid on such a series is valid (Stage 1's create_series refuses a cap below one unit)
    const tiny: AuctionRules = { ...rules, unitsOffered: 5n, walletCapBps: 1000 };
    expect(isBidValid(usdc(9), 1n, requiredEscrow(usdc(9), 1n, 100), tiny)).toBe(false);
    expect(walletCapUnitsAtAuction(10n, 1000)).toBe(1n);
  });
});

// ---------------------------------------------------------------- ours, and the interim cap (S5) and FX (S5) families

describe('fixed point', () => {
  it('parses decimals exactly', () => {
    expect(wadFromDecimal('2.5')).toBe(2_500_000_000_000_000_000n);
    expect(wadFromDecimal('0.08')).toBe(80_000_000_000_000_000n);
    expect(wadToDecimal(wadFromDecimal('0.025'))).toBe('0.025');
    expect(() => wadFromDecimal('1e5')).toThrow();
  });

  it('accepts 18 places and refuses more; its errors carry no value (a share rate is a private term)', () => {
    expect(wadFromDecimal('0.064264264264264264')).toBe(64_264_264_264_264_264n);
    for (const bad of ['0.0642642642642642642', '6426426426e-9', 'x0.0642642642']) {
      let err: unknown = null;
      try {
        wadFromDecimal(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(RangeError);
      expect(`${(err as Error).message}\n${(err as Error).stack}`).not.toMatch(/642642/);
    }
  });
});

describe('C9 fx', () => {
  it('averages the quarter and checks coverage', () => {
    expect(interim.quarterAverageRate(300n * WAD, 100n * WAD, 200, 100)).toBe(2n * WAD);
    expect(interim.coverageOk(72, 90)).toBe(true);
    expect(interim.coverageOk(71, 90)).toBe(false);
    expect(interim.deviationBps(101n, 100n)).toBe(100n);
    expect([interim.withinBand(101n, 100n, 100n), interim.withinBand(102n, 100n, 100n)]).toEqual([true, false]);
    expect(interim.pythToWad(108_123_456n, -8)).toBe(wadFromDecimal('1.08123456'));
  });
});

describe('time', () => {
  it('derives quarters in UTC', () => {
    const p = periodOf(Date.UTC(2026, 9, 7) / 1000);
    expect(p.id).toBe('2026Q4');
    expect(p.days).toBe(92);
    expect(periodsBetween(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 11, 31) / 1000).map((x) => x.id)).toEqual(['2026Q1', '2026Q2', '2026Q3', '2026Q4']);
  });
});

describe('the interim window cap (S5)', () => {
  it('wallet cap is at least one unit', () => {
    expect(interim.walletCapUnits(1_000n, 1_000n)).toBe(100n);
    expect(interim.walletCapUnits(5n, 1_000n)).toBe(1n);
  });
});

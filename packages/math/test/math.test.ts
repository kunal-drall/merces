import { describe, expect, it } from 'vitest';
import * as sdk from '@merces/sdk';
import * as ref from '@merces/reference';
import * as gateway from '../src/index.ts';
import {
  DAY,
  PAYMENT_RANGE_ERROR,
  SeriesStatus,
  WAD,
  capRemaining,
  countdown,
  deadlineSeconds,
  deriveStatus,
  formalNoticeDue,
  fromPid,
  graceSeconds,
  interim,
  isPausedAt,
  newYearGross,
  parsePeriod,
  paymentStable,
  periodFrom,
  periodOf,
  periodsBetween,
  projectDeadlines,
  ratePerUnit,
  redemptionQuote,
  standingOf,
  statusParamsOf,
  toPid,
  wadFromDecimal,
  wadToDecimal,
  type LedgerClock,
  type Pause,
} from '../src/index.ts';

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
] as const;

describe('@merces/math gateway', () => {
  it('re-exports Stage 1\'s own objects, not copies', () => {
    const gw = gateway as unknown as Record<string, unknown>;
    for (const n of SDK_REEXPORTS) expect(gw[n], n).toBe((sdk as unknown as Record<string, unknown>)[n]);
    expect(gw.pidAt).toBe(sdk.periodOf);
    for (const [ours, theirs] of Object.entries(SDK_RENAMED)) expect(gw[ours], ours).toBe((sdk as unknown as Record<string, unknown>)[theirs]);
    for (const n of REFERENCE_REEXPORTS) expect(gw[n], n).toBe((ref as unknown as Record<string, unknown>)[n]);
  });
  it('exports exactly Stage 1, our helpers and `interim` (no swap machinery, no other top-level interim name)', () => {
    const ours = ['periodOf', 'periodOfPid', 'periodFrom', 'parsePeriod', 'periodsBetween', 'toPid', 'fromPid', 'wadFromDecimal', 'wadToDecimal', 'utcDayIndex', 'ratePerUnit', 'paymentStable', 'PAYMENT_RANGE_ERROR', 'statusParamsOf', 'projectDeadlines', 'standingOf', 'capRemaining'];
    const keys = Object.keys(gateway);
    expect([...keys].sort()).toEqual([...SDK_REEXPORTS, 'pidAt', ...Object.keys(SDK_RENAMED), ...REFERENCE_REEXPORTS, ...ours, 'interim'].sort());
    // Stage 1's positional quarterPayment (θ third) and the S2 auction cap are deliberately not re-exported
    expect(keys).not.toContain('quarterPayment');
    expect(keys).not.toContain('walletCapUnits');
    expect(gateway.redemptionQuote).toBe(ref.redemptionQuote);
  });
  it('`interim` keeps exactly the auction family (S2) and the FX family (S5)', () => {
    expect(Object.keys(interim).sort()).toEqual([
      // auction (S2)
      'clearAuction', 'walletCapUnits', 'bidDeposit', 'auctionFee',
      // FX (S5)
      'quarterAverageRate', 'coverageOk', 'deviationBps', 'withinBand', 'pythToWad',
    ].sort());
    // the interim auction cap is not Stage 1's (S2 moves the callers)
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

// ---------------------------------------------------------------- ours, and the interim auction (S2) and FX (S5) families

const USDC = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

describe('fixed point', () => {
  it('parses decimals exactly', () => {
    expect(wadFromDecimal('2.5')).toBe(2_500_000_000_000_000_000n);
    expect(wadFromDecimal('0.08')).toBe(80_000_000_000_000_000n);
    expect(wadToDecimal(wadFromDecimal('0.025'))).toBe('0.025');
    expect(() => wadFromDecimal('1e5')).toThrow();
  });
});

describe('auction fees (interim auction family, S2)', () => {
  it('1% auction fee on the cleared amount; the deposit covers price × quantity plus the fee', () => {
    expect(interim.auctionFee(USDC(100_000), 100n)).toBe(USDC(1_000));
    expect(interim.bidDeposit(USDC(10), 50n, 100n)).toBe(USDC(505));
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

describe('auction clearing', () => {
  it('clears at the lowest winning price with uniform pricing and a wallet cap', () => {
    const res = interim.clearAuction({
      bids: [
        { bidder: 'a', pricePerUnit: USDC(12), quantity: 60n, order: 0 },
        { bidder: 'b', pricePerUnit: USDC(11), quantity: 50n, order: 1 },
        { bidder: 'c', pricePerUnit: USDC(10), quantity: 50n, order: 2 },
        { bidder: 'd', pricePerUnit: USDC(9), quantity: 50n, order: 3 },
        { bidder: 'e', pricePerUnit: USDC(5), quantity: 50n, order: 4 }, // below reserve
      ],
      unitsOffered: 100n,
      reservePrice: USDC(8),
      minimumRaise: USDC(500),
      walletCapUnits: 50n,
      auctionFeeBps: 100n,
    });
    expect(res.success).toBe(true);
    expect(res.unitsSold).toBe(100n);
    expect(res.clearingPrice).toBe(USDC(11));
    const byBidder = Object.fromEntries(res.allocations.map((a) => [a.bidder, a.units]));
    expect(byBidder).toEqual({ a: 50n, b: 50n });
    expect(res.proceeds).toBe(USDC(1_100));
    expect(res.totalFees).toBe(USDC(11));
  });
  it('fails below the minimum raise and with no bids', () => {
    const res = interim.clearAuction({ bids: [{ bidder: 'a', pricePerUnit: USDC(10), quantity: 10n, order: 0 }], unitsOffered: 100n, reservePrice: USDC(8), minimumRaise: USDC(500), walletCapUnits: 50n, auctionFeeBps: 100n });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('below-minimum-raise');
    const none = interim.clearAuction({ bids: [], unitsOffered: 100n, reservePrice: USDC(8), minimumRaise: 0n, walletCapUnits: 50n, auctionFeeBps: 100n });
    expect(none.reason).toBe('no-bids');
  });
  it('breaks price ties by commit order', () => {
    const res = interim.clearAuction({
      bids: [
        { bidder: 'late', pricePerUnit: USDC(10), quantity: 100n, order: 5 },
        { bidder: 'early', pricePerUnit: USDC(10), quantity: 100n, order: 1 },
      ],
      unitsOffered: 100n, reservePrice: 0n, minimumRaise: 0n, walletCapUnits: 60n, auctionFeeBps: 100n,
    });
    const byBidder = Object.fromEntries(res.allocations.map((a) => [a.bidder, a.units]));
    expect(byBidder).toEqual({ early: 60n, late: 40n });
  });
  it('wallet cap is at least one unit', () => {
    expect(interim.walletCapUnits(1_000n, 1_000n)).toBe(100n);
    expect(interim.walletCapUnits(5n, 1_000n)).toBe(1n);
  });
});

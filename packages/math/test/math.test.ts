import { describe, expect, it } from 'vitest';
import {
  WAD,
  accrueNet,
  applyGrossPayment,
  auctionFee,
  averageAnnualPayout,
  bidDeposit,
  capRemaining,
  claimable,
  clearAuction,
  coverageOk,
  daysLate,
  deadlinesFor,
  deviationBps,
  hurdlePrice,
  lateAccrual,
  owedYtd,
  parsePeriod,
  payoutFee,
  perUnitCap,
  periodOf,
  periodPayment,
  periodsBetween,
  pythToWad,
  quarterAverageRate,
  quarterPayment,
  ratePerUnit,
  redemptionQuote,
  rewardDebt,
  tailPayoutPerUnit,
  wadFromDecimal,
  wadToDecimal,
  walletCapUnits,
  yearsSince,
} from '../src/index.ts';

const USDC = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

describe('fixed point', () => {
  it('parses decimals exactly', () => {
    expect(wadFromDecimal('2.5')).toBe(2_500_000_000_000_000_000n);
    expect(wadFromDecimal('0.08')).toBe(80_000_000_000_000_000n);
    expect(wadToDecimal(wadFromDecimal('0.025'))).toBe('0.025');
    expect(() => wadFromDecimal('1e5')).toThrow();
  });
});

describe('C3 payment formula', () => {
  const N = 1_000n; // units
  const s = wadFromDecimal('0.10'); // 10% share
  const r = ratePerUnit(s, N); // 0.0001 per unit in WAD
  const theta = USDC(60_000);

  it('owes nothing until YTD income clears the full annual threshold', () => {
    expect(owedYtd(r, N, USDC(20_000), theta)).toBe(0n);
    expect(owedYtd(r, N, USDC(60_000), theta)).toBe(0n);
  });

  it('crosses the threshold mid-year and pays only the increment per quarter', () => {
    const q1 = quarterPayment({ ratePerUnitWad: r, unitsOutstanding: N, incomeYtdPrev: 0n, incomeYtdNow: USDC(25_000), threshold: theta, fxAvgWad: WAD });
    expect(q1.paymentStable).toBe(0n);
    const q2 = quarterPayment({ ratePerUnitWad: r, unitsOutstanding: N, incomeYtdPrev: USDC(25_000), incomeYtdNow: USDC(50_000), threshold: theta, fxAvgWad: WAD });
    expect(q2.paymentStable).toBe(0n);
    const q3 = quarterPayment({ ratePerUnitWad: r, unitsOutstanding: N, incomeYtdPrev: USDC(50_000), incomeYtdNow: USDC(75_000), threshold: theta, fxAvgWad: WAD });
    // 10% of (75k - 60k) = 1,500
    expect(q3.paymentStable).toBe(USDC(1_500));
    const q4 = quarterPayment({ ratePerUnitWad: r, unitsOutstanding: N, incomeYtdPrev: USDC(75_000), incomeYtdNow: USDC(100_000), threshold: theta, fxAvgWad: WAD });
    expect(q4.paymentStable).toBe(USDC(2_500));
    expect(q1.paymentStable + q2.paymentStable + q3.paymentStable + q4.paymentStable).toBe(USDC(4_000));
  });

  it('never goes negative and rounds down (issuer-favourable)', () => {
    expect(periodPayment(5n, 10n)).toBe(0n);
    // r = 1/3 per unit of 1e18, N=3 → r*N = 999999999999999999 → owed = floor(0.999999... × 10) = 9
    const r3 = ratePerUnit(WAD, 3n);
    expect(owedYtd(r3, 3n, 10n, 0n)).toBe(9n);
  });

  it('converts at the quarter-average FX rate', () => {
    // EUR income, fx = 1.08 USD per EUR
    const q = quarterPayment({ ratePerUnitWad: r, unitsOutstanding: N, incomeYtdPrev: 0n, incomeYtdNow: USDC(70_000), threshold: theta, fxAvgWad: wadFromDecimal('1.08') });
    expect(q.paymentIncome).toBe(USDC(1_000));
    expect(q.paymentStable).toBe(USDC(1_080));
  });
});

describe('C5 fees', () => {
  it('1% auction fee, 5% payout fee, issuer pays nothing', () => {
    expect(auctionFee(USDC(100_000), 100n)).toBe(USDC(1_000));
    expect(payoutFee(USDC(1_500), 500n)).toEqual({ fee: USDC(75), net: USDC(1_425) });
    expect(bidDeposit(USDC(10), 50n, 100n)).toBe(USDC(505));
  });
});

describe('C6 cap accounting', () => {
  const P0 = USDC(10);
  const C = perUnitCap(wadFromDecimal('2.5'), P0); // 25 USDC per unit
  it('computes the per-unit cap', () => {
    expect(C).toBe(USDC(25));
  });
  it('accepts payments below the cap and tracks paid_per_unit', () => {
    const r1 = applyGrossPayment(USDC(1_000), 100n, 0n, C);
    expect(r1.accepted).toBe(USDC(1_000));
    expect(r1.refunded).toBe(0n);
    expect(r1.paidPerUnitWad).toBe(USDC(10) * WAD);
    expect(r1.retired).toBe(false);
  });
  it('accepts only up to the cap, refunds the rest and retires', () => {
    const r2 = applyGrossPayment(USDC(2_000), 100n, USDC(10) * WAD, C);
    expect(r2.accepted).toBe(USDC(1_500));
    expect(r2.refunded).toBe(USDC(500));
    expect(r2.retired).toBe(true);
    expect(capRemaining(C, r2.paidPerUnitWad)).toBe(0n);
    const r3 = applyGrossPayment(USDC(1), 100n, r2.paidPerUnitWad, C);
    expect(r3.accepted).toBe(0n);
    expect(r3.refunded).toBe(USDC(1));
  });
  it('reaches the cap exactly when the last payment is an odd amount', () => {
    const r = applyGrossPayment(USDC(2_500), 3n, 0n, C); // 3 units, cap 75 total; 2500 > 75
    expect(r.accepted).toBe(USDC(75));
    expect(r.refunded).toBe(USDC(2_425));
    expect(r.retired).toBe(true);
  });
  it('reward per share never over-pays the vault', () => {
    let acc = 0n;
    const net = 1_000_003n; // odd base units across 7 units leaves dust
    acc = accrueNet(acc, net, 7n);
    const claims = [3n, 2n, 2n].map((u) => claimable(u, acc, 0n));
    const total = claims.reduce((a, b) => a + b, 0n);
    expect(total).toBeLessThanOrEqual(net);
    expect(net - total).toBeLessThan(7n);
    // a later joiner's debt prevents claiming past distributions
    const debt = rewardDebt(5n, acc);
    expect(claimable(5n, acc, debt)).toBe(0n);
  });
});

describe('C7 redemption', () => {
  const P0 = USDC(10);
  const h = wadFromDecimal('0.08');
  const C = perUnitCap(wadFromDecimal('2.5'), P0);
  const t0 = Date.UTC(2026, 0, 1) / 1000;
  it('hurdle compounds whole years and is linear within the year', () => {
    expect(hurdlePrice(P0, h, t0, t0)).toBe(P0);
    const oneYear = t0 + 365 * 86_400;
    expect(hurdlePrice(P0, h, t0, oneYear)).toBe(USDC(10.8));
    const halfYear = t0 + Math.floor(365 * 86_400 / 2);
    // 10 × (1 + 0.08 × ~0.5) ≈ 10.4 (floor)
    const half = hurdlePrice(P0, h, t0, halfYear);
    expect(half).toBeGreaterThanOrEqual(USDC(10.39));
    expect(half).toBeLessThanOrEqual(USDC(10.4));
    const twoYears = t0 + 2 * 365 * 86_400;
    expect(hurdlePrice(P0, h, t0, twoYears)).toBe(11_664_000n); // 10 × 1.08² = 11.664
  });
  it('bound by hurdle when no payout history', () => {
    const q = redemptionQuote({ capPerUnit: C, paidPerUnitWad: 0n, issuePrice: P0, hurdleWad: h, payoutMultipleK: 5n, settlementTs: t0, nowTs: t0 + 365 * 86_400, annualGrossPerUnit: [] });
    expect(q.boundBy).toBe('hurdle');
    expect(q.pricePerUnit).toBe(USDC(10.8));
    expect(q.tailCapPerUnit).toBe(USDC(25) - USDC(10.8));
  });
  it('bound by k × D_avg when payouts are strong', () => {
    const q = redemptionQuote({ capPerUnit: C, paidPerUnitWad: USDC(6) * WAD, issuePrice: P0, hurdleWad: h, payoutMultipleK: 5n, settlementTs: t0, nowTs: t0 + 2 * 365 * 86_400, annualGrossPerUnit: [USDC(2), USDC(4)] });
    // D_avg = 3, k×D = 15; hurdle = 11.664; C_remaining = 19 → 15
    expect(q.boundBy).toBe('payout');
    expect(q.pricePerUnit).toBe(USDC(15));
  });
  it('bound by the remaining cap', () => {
    const q = redemptionQuote({ capPerUnit: C, paidPerUnitWad: USDC(20) * WAD, issuePrice: P0, hurdleWad: h, payoutMultipleK: 5n, settlementTs: t0, nowTs: t0 + 3 * 365 * 86_400, annualGrossPerUnit: [USDC(5), USDC(10), USDC(5)] });
    expect(q.boundBy).toBe('cap');
    expect(q.pricePerUnit).toBe(USDC(5));
    expect(q.tailCapPerUnit).toBe(0n);
  });
  it('averages only the trailing three full years', () => {
    expect(averageAnnualPayout([])).toBeNull();
    expect(averageAnnualPayout([USDC(1), USDC(2), USDC(3), USDC(4)])).toBe(USDC(3));
  });
  it('tail payouts respect the per-unit tail cap', () => {
    expect(tailPayoutPerUnit(USDC(10), USDC(4), 0n)).toBe(USDC(4));
    expect(tailPayoutPerUnit(USDC(1), USDC(4), USDC(3.5))).toBe(USDC(0.5));
    expect(tailPayoutPerUnit(USDC(1), 0n, 0n)).toBe(0n);
  });
});

describe('C8 lateness', () => {
  const p = parsePeriod('2026Q1');
  it('due 30 days after quarter end, 15 days grace, notice at 90', () => {
    const d = deadlinesFor(p);
    expect(d.dueAt).toBe(p.end + 30 * 86_400);
    expect(d.graceEndsAt).toBe(d.dueAt + 15 * 86_400);
    expect(d.formalNoticeAt).toBe(d.dueAt + 90 * 86_400);
  });
  it('accrues simple interest at the hurdle rate after grace', () => {
    const d = deadlinesFor(p);
    expect(daysLate(d.graceEndsAt, d.graceEndsAt + 10 * 86_400)).toBe(10);
    expect(daysLate(d.graceEndsAt, d.dueAt)).toBe(0);
    // 10,000 × 8% × 73/365 = 160
    expect(lateAccrual(USDC(10_000), wadFromDecimal('0.08'), 73)).toBe(USDC(160));
    expect(lateAccrual(USDC(10_000), wadFromDecimal('0.08'), 0)).toBe(0n);
  });
  it('shifts deadlines by paused seconds', () => {
    const d = deadlinesFor(p, { pausedSeconds: 5 * 86_400 });
    expect(d.dueAt).toBe(p.end + 35 * 86_400);
  });
});

describe('C9 fx', () => {
  it('averages the quarter and checks coverage', () => {
    expect(quarterAverageRate(300n * WAD, 100n * WAD, 200, 100)).toBe(2n * WAD);
    expect(coverageOk(72, 90)).toBe(true);
    expect(coverageOk(71, 90)).toBe(false);
    expect(deviationBps(101n, 100n)).toBe(100n);
    expect(pythToWad(108_123_456n, -8)).toBe(wadFromDecimal('1.08123456'));
  });
});

describe('time', () => {
  it('derives quarters in UTC', () => {
    const p = periodOf(Date.UTC(2026, 9, 7) / 1000);
    expect(p.id).toBe('2026Q4');
    expect(p.days).toBe(92);
    expect(periodsBetween(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 11, 31) / 1000).map((x) => x.id)).toEqual(['2026Q1', '2026Q2', '2026Q3', '2026Q4']);
    expect(yearsSince(0, 365 * 86_400 + 365 * 43_200)).toEqual({ whole: 1, fracWad: WAD / 2n });
  });
});

describe('auction clearing', () => {
  it('clears at the lowest winning price with uniform pricing and a wallet cap', () => {
    const res = clearAuction({
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
    const res = clearAuction({ bids: [{ bidder: 'a', pricePerUnit: USDC(10), quantity: 10n, order: 0 }], unitsOffered: 100n, reservePrice: USDC(8), minimumRaise: USDC(500), walletCapUnits: 50n, auctionFeeBps: 100n });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('below-minimum-raise');
    const none = clearAuction({ bids: [], unitsOffered: 100n, reservePrice: USDC(8), minimumRaise: 0n, walletCapUnits: 50n, auctionFeeBps: 100n });
    expect(none.reason).toBe('no-bids');
  });
  it('breaks price ties by commit order', () => {
    const res = clearAuction({
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
    expect(walletCapUnits(1_000n, 1_000n)).toBe(100n);
    expect(walletCapUnits(5n, 1_000n)).toBe(1n);
  });
});

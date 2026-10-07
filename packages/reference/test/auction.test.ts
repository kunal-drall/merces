import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  finalizeSettlement,
  findClearingPrice,
  isBidValid,
  isClearingPriceValid,
  marginalAllocation,
  processBid,
  requiredEscrow,
  tallyBids,
  walletCapUnitsAtAuction,
  type AuctionRules,
  type RevealedBid,
} from "../src/index.js";

const USDC = 1_000_000n;
const rules: AuctionRules = { unitsOffered: 1000n, reservePrice: 1n * USDC, minRaise: 500n * USDC, walletCapBps: 1000, auctionFeeBps: 100, nonRevealChargeBps: 100 };

function bid(price: bigint, quantity: bigint, escrow?: bigint, revealIndex = 0): RevealedBid {
  const e = escrow ?? requiredEscrow(price, quantity, rules.auctionFeeBps);
  return { price, quantity, escrow: e, valid: isBidValid(price, quantity, e, rules), revealIndex };
}

describe("auction rules (SPEC §5.2)", () => {
  it("escrow and wallet cap", () => {
    expect(requiredEscrow(1n * USDC, 100n, 100)).toBe(101n * USDC);
    expect(requiredEscrow(999_999n, 1n, 100)).toBe(999_999n + 9_999n);
    expect(walletCapUnitsAtAuction(1000n, 1000)).toBe(100n);
    expect(walletCapUnitsAtAuction(999n, 1000)).toBe(99n);
  });
  it("validity: reserve, quantity ≥ 1, cap, escrow", () => {
    expect(isBidValid(1n * USDC, 100n, 101n * USDC, rules)).toBe(true);
    expect(isBidValid(1n * USDC, 100n, 101n * USDC - 1n, rules)).toBe(false);
    expect(isBidValid(1n * USDC - 1n, 1n, 10n * USDC, rules)).toBe(false);
    expect(isBidValid(1n * USDC, 0n, 10n * USDC, rules)).toBe(false);
    expect(isBidValid(1n * USDC, 101n, 1000n * USDC, rules)).toBe(false);
    expect(isBidValid(2n * USDC, 100n, 1000n * USDC, rules)).toBe(true); // over-collateralised is fine
  });
});

describe("clearing and allocation", () => {
  it("oversubscribed with a tie at the margin: pro-rata, rounded down", () => {
    const r = { ...rules, unitsOffered: 100n, minRaise: 50n * USDC };
    const bids = [bid(1_100_000n, 60n), bid(1_000_000n, 30n), bid(1_000_000n, 30n)];
    const p = findClearingPrice(bids, r.unitsOffered);
    expect(p).toBe(1_000_000n);
    const t = tallyBids(bids, p);
    expect(t).toEqual({ qAbove: 60n, qAt: 60n, minValidPrice: 1_000_000n, talliedCount: 3 });
    const s = finalizeSettlement(t, r, p);
    expect(s.R).toBe(40n);
    expect(s.unitsSoldUpper).toBe(100n);
    expect(s.failed).toBe(false);
    expect(marginalAllocation(s.R, 30n, s.qAt)).toBe(20n);
    // the proposals 1.1 and anything else are invalid
    expect(isClearingPriceValid(tallyBids(bids, 1_100_000n), r.unitsOffered, 1_100_000n)).toBe(false);
    expect(() => finalizeSettlement(tallyBids(bids, 900_000n), r, 900_000n)).toThrow("InvalidClearingPrice");
  });
  it("marginal rounding leaves dust unsold", () => {
    const r = { ...rules, unitsOffered: 100n, walletCapBps: 10_000 };
    const bids = [bid(2n * USDC, 59n), bid(1n * USDC, 50n), bid(1n * USDC, 20n), bid(1n * USDC, 7n)];
    const p = findClearingPrice(bids, r.unitsOffered);
    const s = finalizeSettlement(tallyBids(bids, p), r, p);
    expect(s.R).toBe(41n);
    const allocs = bids.slice(1).map((b) => marginalAllocation(s.R, b.quantity, s.qAt));
    expect(allocs).toEqual([26n, 10n, 3n]); // floor(41×50/77), floor(41×20/77), floor(41×7/77)
    expect(59n + allocs.reduce((a, b) => a + b, 0n)).toBe(98n); // 2 units of dust stay unminted
  });
  it("undersubscribed: p* is the lowest valid price and everyone fills", () => {
    const bids = [bid(3n * USDC, 50n), bid(2n * USDC, 40n), bid(900_000n, 100n)];
    expect(bids[2]!.valid).toBe(false);
    const p = findClearingPrice(bids, rules.unitsOffered);
    expect(p).toBe(2n * USDC);
    const s = finalizeSettlement(tallyBids(bids, p), rules, p);
    expect(s).toMatchObject({ R: 40n, qAbove: 50n, unitsSoldUpper: 90n, proceedsUpper: 180n * USDC, failed: true });
    const ok = finalizeSettlement(tallyBids(bids, p), { ...rules, minRaise: 180n * USDC }, p);
    expect(ok.failed).toBe(false);
    expect(() => finalizeSettlement(tallyBids(bids, 3n * USDC), rules, 3n * USDC)).toThrow("InvalidClearingPrice");
  });
  it("no valid bids: proposal 0 is accepted and the raise fails", () => {
    const bids = [bid(900_000n, 10n)];
    expect(findClearingPrice(bids, rules.unitsOffered)).toBe(0n);
    expect(finalizeSettlement(tallyBids(bids, 0n), rules, 0n).failed).toBe(true);
    expect(() => finalizeSettlement(tallyBids(bids, 1n), rules, 1n)).toThrow("InvalidClearingPrice");
    expect(finalizeSettlement(tallyBids([], 0n), rules, 0n).failed).toBe(true);
  });
  it("processBid outcomes", () => {
    const settled = { failed: false, clearingPrice: 1n * USDC, R: 40n, qAt: 60n };
    const above = processBid({ ...bid(1_100_000n, 60n), revealed: true }, settled, rules);
    expect(above).toEqual({ alloc: 60n, cost: 60n * USDC, fee: 600_000n, refund: requiredEscrow(1_100_000n, 60n, 100) - 60n * USDC - 600_000n, charge: 0n });
    const at = processBid({ ...bid(1n * USDC, 30n), revealed: true }, settled, rules);
    expect(at).toEqual({ alloc: 20n, cost: 20n * USDC, fee: 200_000n, refund: 30_300_000n - 20_200_000n, charge: 0n });
    const below = processBid({ ...bid(1n * USDC, 5n), price: 999_999n, valid: false, revealed: true }, settled, rules);
    expect(below).toEqual({ alloc: 0n, cost: 0n, fee: 0n, refund: 5_050_000n, charge: 0n });
    const unrevealed = processBid({ price: 0n, quantity: 0n, valid: false, revealed: false, escrow: 10n * USDC }, settled, rules);
    expect(unrevealed).toEqual({ alloc: 0n, cost: 0n, fee: 0n, refund: 9_900_000n, charge: 100_000n });
    const failedUnrevealed = processBid({ price: 0n, quantity: 0n, valid: false, revealed: false, escrow: 10n * USDC }, { ...settled, failed: true }, rules);
    expect(failedUnrevealed).toEqual({ alloc: 0n, cost: 0n, fee: 0n, refund: 10n * USDC, charge: 0n });
  });

  const bidArb = fc.record({
    price: fc.bigInt({ min: 500_000n, max: 3_000_000n }),
    quantity: fc.bigInt({ min: 0n, max: 120n }),
    extra: fc.bigInt({ min: 0n, max: 5n * USDC }),
    revealed: fc.boolean(),
  });

  it("property: exactly one valid clearing price (or 0 when nothing is valid); escrow is conserved; units sold ≤ N", () => {
    fc.assert(
      fc.property(fc.array(bidArb, { minLength: 1, maxLength: 12 }), fc.bigInt({ min: 1n, max: 500n }), (raw, N) => {
        const r = { ...rules, unitsOffered: N };
        const bids = raw.map((b, i) => {
          const escrow = requiredEscrow(b.price, b.quantity, r.auctionFeeBps) + b.extra;
          return { ...b, escrow, valid: b.revealed && isBidValid(b.price, b.quantity, escrow, r), revealIndex: i };
        });
        const revealed = bids.filter((b) => b.revealed);
        const p = findClearingPrice(revealed, N);
        const candidates = [...new Set(revealed.filter((b) => b.valid).map((b) => b.price))];
        const valid = candidates.filter((c) => isClearingPriceValid(tallyBids(revealed, c), N, c));
        expect(valid.length).toBe(candidates.length === 0 ? 0 : 1);
        const t = tallyBids(revealed, p);
        const s = finalizeSettlement(t, r, p);
        const settled = { failed: s.failed, clearingPrice: p, R: s.R, qAt: s.qAt };
        let units = 0n;
        let proceeds = 0n;
        let fees = 0n;
        for (const b of bids) {
          const o = processBid(b, settled, r);
          expect(o.refund + o.cost + o.fee + o.charge).toBe(b.escrow);
          expect(o.refund >= 0n).toBe(true);
          units += o.alloc;
          proceeds += o.cost;
          fees += o.fee;
          if (s.failed) expect(o.charge + o.fee + o.cost).toBe(0n);
        }
        expect(units <= N).toBe(true);
        expect(units <= s.unitsSoldUpper).toBe(true);
        expect(proceeds).toBe(p * units);
        if (!s.failed) expect(s.proceedsUpper >= r.minRaise).toBe(true);
        if (!s.failed && t.qAbove + t.qAt >= N) expect(s.unitsSoldUpper).toBe(N);
        expect(fees <= proceeds / 100n + BigInt(bids.length)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

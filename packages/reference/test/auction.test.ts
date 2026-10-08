import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  beginSettlement,
  claimsFor,
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

/** Honest keeper: propose p with the matching claims, tally, finalize. */
function settle(bids: RevealedBid[], r: AuctionRules, p: bigint) {
  const claims = claimsFor(bids, p);
  const proposal = beginSettlement(r.unitsOffered, p, claims.qAboveClaim, claims.qAtClaim);
  const tally = tallyBids(bids, proposal);
  return { proposal, tally, outcome: finalizeSettlement(tally, bids.filter((b) => b.valid).length, r, proposal) };
}

describe("auction rules (SPEC v1.1 §5.2)", () => {
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
    expect(isBidValid(2n * USDC, 100n, 1000n * USDC, rules)).toBe(true);
  });
  it("r_claim saturates", () => {
    expect(beginSettlement(100n, 1n, 60n, 60n).rClaim).toBe(40n);
    expect(beginSettlement(100n, 1n, 100n, 60n).rClaim).toBe(0n);
    expect(beginSettlement(100n, 1n, 150n, 60n).rClaim).toBe(0n);
    expect(beginSettlement(100n, 1n, 10n, 5n).rClaim).toBe(5n);
  });
});

describe("one-pass settlement", () => {
  it("oversubscribed with a tie at the margin: exact units_sold from alloc_sum", () => {
    const r = { ...rules, unitsOffered: 100n, minRaise: 50n * USDC };
    const bids = [bid(1_100_000n, 60n), bid(1_000_000n, 30n), bid(1_000_000n, 30n)];
    const p = findClearingPrice(bids, r.unitsOffered);
    expect(p).toBe(1_000_000n);
    const { proposal, tally, outcome } = settle(bids, r, p!);
    expect(proposal.rClaim).toBe(40n);
    expect(tally).toEqual({ qAbove: 60n, qAt: 60n, allocSum: 40n, minValidPrice: 1_000_000n, talliedCount: 3 });
    expect(outcome).toEqual({ kind: "settled", clearingPrice: 1_000_000n, R: 40n, qAt: 60n, qAbove: 60n, unitsSold: 100n, proceeds: 100n * USDC });
    expect(marginalAllocation(40n, 30n, 60n)).toBe(20n);
  });
  it("marginal rounding dust is excluded from units_sold and proceeds in the same pass", () => {
    const r = { ...rules, unitsOffered: 100n, walletCapBps: 10_000, minRaise: 50n * USDC };
    const bids = [bid(2n * USDC, 59n), bid(1n * USDC, 50n), bid(1n * USDC, 20n), bid(1n * USDC, 7n)];
    const { outcome, proposal } = settle(bids, r, 1n * USDC);
    expect(proposal.rClaim).toBe(41n);
    expect(outcome).toMatchObject({ kind: "settled", unitsSold: 98n, proceeds: 98n * USDC }); // 59 + 26 + 10 + 3
  });
  it("undersubscribed: p* is the lowest valid price; min raise is tested on exact proceeds", () => {
    const bids = [bid(3n * USDC, 50n), bid(2n * USDC, 40n), bid(900_000n, 100n)];
    expect(bids[2]!.valid).toBe(false);
    const p = findClearingPrice(bids, rules.unitsOffered);
    expect(p).toBe(2n * USDC);
    expect(settle(bids, rules, p!).outcome).toEqual({ kind: "failed", reason: "MinRaise", clearingPrice: 2n * USDC, unitsSold: 90n, proceeds: 180n * USDC });
    expect(settle(bids, { ...rules, minRaise: 180n * USDC }, p!).outcome).toMatchObject({ kind: "settled", unitsSold: 90n, proceeds: 180n * USDC });
  });
  it("rejections instead of reverts: wrong claims, wrong price", () => {
    const r = { ...rules, unitsOffered: 100n, minRaise: 50n * USDC };
    const bids = [bid(1_100_000n, 60n), bid(1_000_000n, 30n), bid(1_000_000n, 30n)];
    const wrongClaims = beginSettlement(100n, 1_000_000n, 60n, 59n);
    expect(finalizeSettlement(tallyBids(bids, wrongClaims), 3, r, wrongClaims)).toEqual({ kind: "rejected", reason: "ClaimMismatch" });
    const wrongPrice = settle(bids, r, 1_100_000n);
    expect(wrongPrice.outcome).toEqual({ kind: "rejected", reason: "InvalidClearingPrice" });
    expect(settle(bids, r, 900_000n).outcome).toEqual({ kind: "rejected", reason: "ClaimMismatch" }); // honest claims for an unrevealed price are (120, 0); tally gives the same… except min_valid_price
  });
  it("no valid bids → Failed with clearing price 0 regardless of the proposal", () => {
    const bids = [bid(900_000n, 10n)];
    expect(findClearingPrice(bids, rules.unitsOffered)).toBeNull();
    const proposal = beginSettlement(rules.unitsOffered, 5n * USDC, 0n, 0n);
    expect(finalizeSettlement(tallyBids(bids, proposal), 0, rules, proposal)).toEqual({ kind: "failed", reason: "NoValidBids", clearingPrice: 0n, unitsSold: 0n, proceeds: 0n });
    expect(finalizeSettlement(tallyBids([], proposal), 0, rules, proposal).kind).toBe("failed");
  });
  it("process_bid outcomes record what the bidder is owed", () => {
    const settled = { failed: false, clearingPrice: 1n * USDC, R: 40n, qAt: 60n };
    expect(processBid({ ...bid(1_100_000n, 60n), revealed: true }, settled, rules)).toEqual({ alloc: 60n, cost: 60n * USDC, fee: 600_000n, pendingRefund: requiredEscrow(1_100_000n, 60n, 100) - 60n * USDC - 600_000n, charge: 0n });
    expect(processBid({ ...bid(1n * USDC, 30n), revealed: true }, settled, rules)).toEqual({ alloc: 20n, cost: 20n * USDC, fee: 200_000n, pendingRefund: 30_300_000n - 20_200_000n, charge: 0n });
    expect(processBid({ ...bid(1n * USDC, 5n), price: 999_999n, valid: false, revealed: true }, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: 5_050_000n, charge: 0n });
    expect(processBid({ price: 0n, quantity: 0n, valid: false, revealed: false, escrow: 10n * USDC }, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: 9_900_000n, charge: 100_000n });
    expect(processBid({ price: 0n, quantity: 0n, valid: false, revealed: false, escrow: 10n * USDC }, { ...settled, failed: true }, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: 10n * USDC, charge: 0n });
  });

  const bidArb = fc.record({
    price: fc.bigInt({ min: 500_000n, max: 3_000_000n }),
    quantity: fc.bigInt({ min: 0n, max: 120n }),
    extra: fc.bigInt({ min: 0n, max: 5n * USDC }),
    revealed: fc.boolean(),
  });

  it("property: exactly one valid price when a valid bid exists; honest claims settle; Σ alloc == units_sold; escrow conserved", () => {
    fc.assert(
      fc.property(fc.array(bidArb, { minLength: 1, maxLength: 12 }), fc.bigInt({ min: 1n, max: 500n }), (raw, N) => {
        const r = { ...rules, unitsOffered: N };
        const bids = raw.map((b, i) => {
          const escrow = requiredEscrow(b.price, b.quantity, r.auctionFeeBps) + b.extra;
          return { ...b, escrow, valid: b.revealed && isBidValid(b.price, b.quantity, escrow, r), revealIndex: i };
        });
        const revealed = bids.filter((b) => b.revealed);
        const validCount = revealed.filter((b) => b.valid).length;
        const candidates = [...new Set(revealed.filter((b) => b.valid).map((b) => b.price))];
        const valid = candidates.filter((c) => isClearingPriceValid(tallyBids(revealed, beginSettlement(N, c, 0n, 0n)), N, c));
        expect(valid.length).toBe(validCount === 0 ? 0 : 1);
        const p = findClearingPrice(revealed, N) ?? 0n;
        const { outcome } = settle(revealed, r, p);
        expect(outcome.kind).not.toBe("rejected");
        const failed = outcome.kind === "failed";
        const s = { failed, clearingPrice: p, R: outcome.kind === "settled" ? outcome.R : 0n, qAt: outcome.kind === "settled" ? outcome.qAt : 0n };
        let units = 0n;
        let proceeds = 0n;
        for (const b of bids) {
          const o = processBid(b, s, r);
          expect(o.pendingRefund + o.cost + o.fee + o.charge).toBe(b.escrow);
          expect(o.pendingRefund >= 0n).toBe(true);
          units += o.alloc;
          proceeds += o.cost;
          if (failed) expect(o.charge + o.fee + o.cost).toBe(0n);
        }
        if (outcome.kind === "settled") {
          expect(units).toBe(outcome.unitsSold);
          expect(proceeds).toBe(outcome.proceeds);
          expect(outcome.proceeds >= r.minRaise).toBe(true);
          expect(units <= N).toBe(true);
        } else {
          expect(units).toBe(0n);
          if (outcome.reason === "MinRaise") expect(outcome.proceeds < r.minRaise).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { OrderSide } from "@merces/sdk";
import {
  classifyWindowPrice,
  computeFills,
  finalizeWindow,
  findWindowClearingPrice,
  isNoMatchValid,
  isOrderValid,
  requiredBidEscrow,
  tallyOrders,
  walletCapUnits,
  type WindowClearing,
  type WindowOrder,
} from "../src/index.js";

const USDC = 1_000_000n;
const rules = { unitsOutstanding: 1000n, walletCapBps: 1000, windowFeeBps: 100 };
let idx = 0;
function ask(owner: string, price: bigint, quantity: bigint, escrow = quantity): WindowOrder {
  return { owner, side: OrderSide.Ask, escrow, revealed: true, valid: isOrderValid(OrderSide.Ask, price, quantity, escrow, 0n, rules), price, quantity, revealIndex: idx++ };
}
function bidO(owner: string, price: bigint, quantity: bigint, balance = 0n, escrow?: bigint): WindowOrder {
  const e = escrow ?? requiredBidEscrow(price, quantity, rules.windowFeeBps);
  return { owner, side: OrderSide.Bid, escrow: e, revealed: true, valid: isOrderValid(OrderSide.Bid, price, quantity, e, balance, rules), price, quantity, revealIndex: idx++ };
}
function settled(orders: WindowOrder[], p: bigint): WindowClearing {
  const f = finalizeWindow(tallyOrders(orders, p), p);
  if (f.kind !== "settled") throw new Error(`not settled: ${f.kind}`);
  return f.clearing;
}
const byOwner = (fills: ReturnType<typeof computeFills>) => Object.fromEntries(fills.map((f) => [f.owner, f]));

describe("window order validity (SPEC v1.1 §7)", () => {
  it("cap bound, escrow and quantities", () => {
    expect(walletCapUnits(1000n, 1000)).toBe(100n);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC, 0n, rules)).toBe(true);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC - 1n, 0n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC, 1n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 0n, 101n * USDC, 0n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Ask, 1n * USDC, 10n, 10n, 0n, rules)).toBe(true);
    expect(isOrderValid(OrderSide.Ask, 1n * USDC, 11n, 10n, 0n, rules)).toBe(false);
  });
});

describe("branch A (supply-limited): first-come fills at the margin", () => {
  it("clears all supply at ≤ p*; marginal bids fill in ascending reveal index; no dust", () => {
    idx = 0;
    const orders = [ask("s1", 2n * USDC, 30n), ask("s2", 3n * USDC, 20n), ask("s3", 3n * USDC, 10n), bidO("b1", 4n * USDC, 25n), bidO("b2", 3n * USDC, 20n), bidO("b3", 3n * USDC, 25n), bidO("b4", 2n * USDC, 50n)];
    const p = findWindowClearingPrice(orders);
    expect(p).toBe(3n * USDC);
    const t = tallyOrders(orders, p!);
    expect(t).toMatchObject({ dAbove: 25n, dAt: 45n, sBelow: 30n, sAt: 30n, maxBid: 4n * USDC, minAsk: 2n * USDC, validCount: 7 });
    const c = settled(orders, p!);
    expect(c).toMatchObject({ branch: "SupplyLimited", matchedUnits: 60n, marginalRemaining: 35n });
    const f = byOwner(computeFills(orders, c, rules.windowFeeBps));
    expect(f["b1"]!.fill).toBe(25n);
    expect(f["b2"]!.fill).toBe(20n); // first marginal bid (reveal index 4) is filled first
    expect(f["b3"]!.fill).toBe(15n); // 35 − 20
    expect(f["b4"]!.fill).toBe(0n);
    expect(f["s1"]!.fill).toBe(30n);
    expect(f["s2"]!.fill).toBe(20n);
    expect(f["s3"]!.fill).toBe(10n);
    expect(f["b1"]).toMatchObject({ cost: 75n * USDC, fee: 750_000n, refund: 101n * USDC - 75n * USDC - 750_000n });
    expect(f["b3"]!.refund).toBe(f["b3"]!.cost === 45n * USDC ? requiredBidEscrow(3n * USDC, 25n, 100) - 45n * USDC - 450_000n : -1n);
    const bought = Object.values(f).filter((x) => x.side === OrderSide.Bid).reduce((a, x) => a + x.fill, 0n);
    const sold = Object.values(f).filter((x) => x.side === OrderSide.Ask).reduce((a, x) => a + x.fill, 0n);
    expect(bought).toBe(60n);
    expect(sold).toBe(60n);
    expect(finalizeWindow(tallyOrders(orders, 2n * USDC), 2n * USDC)).toEqual({ kind: "rejected", reason: "InvalidWindowPrice" });
    expect(finalizeWindow(tallyOrders(orders, 4n * USDC), 4n * USDC)).toEqual({ kind: "rejected", reason: "InvalidWindowPrice" });
    expect(finalizeWindow(tallyOrders(orders, null), null)).toEqual({ kind: "rejected", reason: "InvalidWindowPrice" });
  });
  it("no crossing → NO_MATCH; an empty side is NO_MATCH too", () => {
    idx = 0;
    const orders = [ask("s1", 5n * USDC, 10n), bidO("b1", 4n * USDC, 10n)];
    expect(findWindowClearingPrice(orders)).toBeNull();
    expect(finalizeWindow(tallyOrders(orders, null), null)).toEqual({ kind: "nomatch" });
    expect(isNoMatchValid(tallyOrders([ask("s1", 5n * USDC, 10n)], null))).toBe(true);
    expect(isNoMatchValid(tallyOrders([], null))).toBe(true);
  });
  it("unrevealed and invalid orders are ignored and fully refunded", () => {
    idx = 0;
    const orders = [ask("s1", 2n * USDC, 10n), bidO("b1", 2n * USDC, 10n), { ...bidO("b2", 9n * USDC, 10n), revealed: false }, ask("s2", 1n * USDC, 50n, 5n)];
    expect(orders[3]!.valid).toBe(false);
    const p = findWindowClearingPrice(orders)!;
    const f = byOwner(computeFills(orders, settled(orders, p), 100));
    expect(f["b2"]).toMatchObject({ fill: 0n, cost: 0n, fee: 0n, refund: orders[2]!.escrow });
    expect(f["s2"]).toMatchObject({ fill: 0n, refund: 5n });
    expect(f["b1"]!.fill).toBe(10n);
  });
  it("a buyer removed from the allowlist before fill is cancelled; its units return to the sellers", () => {
    idx = 0;
    const orders = [ask("s1", 2n * USDC, 10n), ask("s2", 3n * USDC, 10n), bidO("b1", 3n * USDC, 12n), bidO("b2", 3n * USDC, 8n)];
    const c = settled(orders, 3n * USDC);
    expect(c).toMatchObject({ branch: "SupplyLimited", matchedUnits: 20n, marginalRemaining: 20n });
    const f = byOwner(computeFills(orders, c, 100, (o) => o !== "b1"));
    expect(f["b1"]).toMatchObject({ fill: 0n, cancelled: true, refund: orders[2]!.escrow });
    expect(f["b2"]!.fill).toBe(8n);
    expect(f["s2"]!.fill).toBe(0n); // taken back from the marginal ask first
    expect(f["s1"]!.fill).toBe(8n);
    expect(f["s1"]!.refund).toBe(2n);
  });
});

describe("branch B (demand-limited)", () => {
  it("more supply than demand at the crossing: marginal asks first-come, bids fill fully", () => {
    idx = 0;
    const orders = [ask("s1", 9n * USDC, 7n), ask("s2", 9n * USDC, 5n), ask("s3", 8n * USDC, 2n), bidO("b1", 9n * USDC, 3n), bidO("b2", 9n * USDC, 4n)];
    const p = findWindowClearingPrice(orders)!;
    expect(p).toBe(9n * USDC);
    const c = settled(orders, p);
    expect(c).toMatchObject({ branch: "DemandLimited", matchedUnits: 7n, marginalRemaining: 5n });
    const f = byOwner(computeFills(orders, c, 100));
    expect(f["s3"]!.fill).toBe(2n);
    expect(f["s1"]!.fill).toBe(5n); // first marginal ask takes the whole remainder
    expect(f["s2"]!.fill).toBe(0n);
    expect(f["b1"]!.fill).toBe(3n);
    expect(f["b2"]!.fill).toBe(4n);
  });
  it("the spec-v1.0 stuck book (ask 8×5, bid 10×1) clears demand-limited at 8", () => {
    idx = 0;
    const orders = [ask("s1", 8n * USDC, 5n), bidO("b1", 10n * USDC, 1n)];
    expect(classifyWindowPrice(tallyOrders(orders, 8n * USDC))).toBe("DemandLimited");
    expect(classifyWindowPrice(tallyOrders(orders, 10n * USDC))).toBeNull();
    const f = byOwner(computeFills(orders, settled(orders, 8n * USDC), 100));
    expect(f["b1"]).toMatchObject({ fill: 1n, cost: 8n * USDC, fee: 80_000n });
    expect(f["s1"]).toMatchObject({ fill: 1n, refund: 4n });
  });
});

describe("brute force: ≥ 20,000 random order books", () => {
  const orderArb = fc.record({
    side: fc.constantFrom(OrderSide.Bid, OrderSide.Ask),
    price: fc.bigInt({ min: 1n, max: 5n }),
    quantity: fc.bigInt({ min: 1n, max: 9n }),
    revealed: fc.boolean(),
  });
  it("when max_bid ≥ min_ask exactly one revealed price satisfies exactly one branch and maximises min(D,S); otherwise NO_MATCH; fills conserve units and money", () => {
    fc.assert(
      fc.property(fc.array(orderArb, { minLength: 0, maxLength: 9 }), fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }), (raw, allowBits) => {
        const orders: WindowOrder[] = raw.map((o, i) => {
          const escrow = o.side === OrderSide.Ask ? o.quantity : requiredBidEscrow(o.price, o.quantity, 100);
          return { owner: `w${i}`, side: o.side, escrow, revealed: o.revealed, valid: o.revealed, price: o.price, quantity: o.quantity, revealIndex: i };
        });
        const prices = [1n, 2n, 3n, 4n, 5n];
        const base = tallyOrders(orders, null);
        const crossing = base.maxBid !== null && base.minAsk !== null && base.maxBid >= base.minAsk;
        const satisfying = prices.filter((p) => classifyWindowPrice(tallyOrders(orders, p)) !== null);
        // exactly one branch per price (classify returns a single branch by construction: check the two predicates separately)
        for (const p of prices) {
          const t = tallyOrders(orders, p);
          const S = t.sBelow + t.sAt;
          const D = t.dAbove + t.dAt;
          const a = S > 0n && t.dAbove < S && S <= D && (t.sAt > 0n || t.dAt > 0n);
          const b = D > 0n && t.sBelow <= D && D < S && (t.sAt > 0n || t.dAt > 0n);
          expect(a && b).toBe(false);
        }
        if (!crossing) {
          expect(satisfying).toEqual([]);
          expect(isNoMatchValid(base)).toBe(true);
          expect(finalizeWindow(base, null).kind).toBe("nomatch");
          return;
        }
        expect(satisfying.length).toBe(1);
        expect(isNoMatchValid(base)).toBe(false);
        const p = satisfying[0]!;
        const c = settled(orders, p);
        // maximises min(D, S) over all revealed prices
        const volumes = prices.map((q) => {
          const t = tallyOrders(orders, q);
          const S = t.sBelow + t.sAt;
          const D = t.dAbove + t.dAt;
          return S < D ? S : D;
        });
        const best = volumes.reduce((m, v) => (v > m ? v : m), 0n);
        expect(c.matchedUnits).toBe(best);
        expect(c.matchedUnits > 0n).toBe(true);
        expect(findWindowClearingPrice(orders)).toBe(p);
        // fills: conservation with and without allowlist cancellations
        for (const isAllowed of [() => true, (o: string) => allowBits[Number(o.slice(1))]!]) {
          const fills = computeFills(orders, c, 100, isAllowed);
          let bought = 0n;
          let sold = 0n;
          let paid = 0n;
          let received = 0n;
          let fees = 0n;
          for (const f of fills) {
            const o = orders[Number(f.owner.slice(1))]!;
            expect(f.fill >= 0n && f.fill <= o.quantity).toBe(true);
            if (!o.revealed) expect(f.fill).toBe(0n);
            if (f.side === OrderSide.Bid) {
              expect(f.cost + f.fee + f.refund).toBe(o.escrow);
              bought += f.fill;
              paid += f.cost;
              fees += f.fee;
              if (o.revealed && o.price < p) expect(f.fill).toBe(0n);
            } else {
              expect(f.fill + f.refund).toBe(o.escrow);
              sold += f.fill;
              received += f.cost;
              if (o.revealed && o.price > p) expect(f.fill).toBe(0n);
            }
          }
          expect(bought).toBe(sold);
          expect(paid).toBe(received);
          expect(paid).toBe(p * bought);
          expect(bought <= c.matchedUnits).toBe(true);
          if (isAllowed === (() => true) || fills.every((f) => !f.cancelled)) expect(bought).toBe(c.matchedUnits);
          expect(fees >= 0n).toBe(true);
        }
      }),
      { numRuns: 20_000 },
    );
  }, 600_000);
});

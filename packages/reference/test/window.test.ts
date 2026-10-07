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

describe("window order validity (SPEC §7)", () => {
  it("cap room, escrow and quantities", () => {
    expect(walletCapUnits(1000n, 1000)).toBe(100n);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC, 0n, rules)).toBe(true);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC - 1n, 0n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 100n, 101n * USDC, 1n, rules)).toBe(false); // cap room is 99
    expect(isOrderValid(OrderSide.Bid, 1n * USDC, 0n, 101n * USDC, 0n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Ask, 1n * USDC, 10n, 10n, 0n, rules)).toBe(true);
    expect(isOrderValid(OrderSide.Ask, 1n * USDC, 11n, 10n, 0n, rules)).toBe(false);
    expect(isOrderValid(OrderSide.Ask, 0n, 1n, 10n, 0n, rules)).toBe(false);
  });
});

describe("clearing (spec's supply-limited crossing)", () => {
  it("clears all supply at ≤ p*, marginal bids pro rata, dust back to the last marginal ask", () => {
    idx = 0;
    const orders = [ask("s1", 2n * USDC, 30n), ask("s2", 3n * USDC, 20n), ask("s3", 3n * USDC, 10n), bidO("b1", 4n * USDC, 25n), bidO("b2", 3n * USDC, 20n), bidO("b3", 3n * USDC, 25n), bidO("b4", 2n * USDC, 50n)];
    const p = findWindowClearingPrice(orders);
    expect(p).toBe(3n * USDC);
    const t = tallyOrders(orders, p!);
    expect(t).toMatchObject({ dAbove: 25n, dAt: 45n, sBelow: 30n, sAt: 30n, maxBid: 4n * USDC, minAsk: 2n * USDC });
    const c = finalizeWindow(t, p!);
    expect(c).toMatchObject({ kind: "supply_limited", matchedUnits: 60n, R: 35n, dAt: 45n });
    const fills = computeFills(orders, c, rules.windowFeeBps);
    const byOwner = Object.fromEntries(fills.map((f) => [f.owner, f]));
    expect(byOwner["b1"]!.fill).toBe(25n);
    expect(byOwner["b2"]!.fill).toBe(15n); // floor(35 × 20 / 45)
    expect(byOwner["b3"]!.fill).toBe(19n); // floor(35 × 25 / 45)
    expect(byOwner["b4"]!.fill).toBe(0n);
    // 1 unit of dust returns to the ask at p* with the highest reveal index (s3)
    expect(byOwner["s1"]!.fill).toBe(30n);
    expect(byOwner["s2"]!.fill).toBe(20n);
    expect(byOwner["s3"]!.fill).toBe(9n);
    expect(byOwner["s3"]!.refund).toBe(1n);
    expect(byOwner["b1"]!.cost).toBe(75n * USDC);
    expect(byOwner["b1"]!.fee).toBe(750_000n);
    expect(byOwner["b1"]!.refund).toBe(101n * USDC - 75n * USDC - 750_000n);
    const bought = fills.filter((f) => f.side === OrderSide.Bid).reduce((a, f) => a + f.fill, 0n);
    const sold = fills.filter((f) => f.side === OrderSide.Ask).reduce((a, f) => a + f.fill, 0n);
    expect(bought).toBe(sold);
    expect(bought).toBe(59n);
    // other prices are invalid; NO_MATCH is invalid because max_bid ≥ min_ask
    expect(classifyWindowPrice(tallyOrders(orders, 2n * USDC))).toBeNull();
    expect(classifyWindowPrice(tallyOrders(orders, 4n * USDC))).toBeNull();
    expect(isNoMatchValid(tallyOrders(orders, null))).toBe(false);
    expect(() => finalizeWindow(tallyOrders(orders, 4n * USDC), 4n * USDC)).toThrow("InvalidWindowPrice");
  });
  it("no crossing → NO_MATCH", () => {
    idx = 0;
    const orders = [ask("s1", 5n * USDC, 10n), bidO("b1", 4n * USDC, 10n)];
    expect(findWindowClearingPrice(orders)).toBeNull();
    expect(isNoMatchValid(tallyOrders(orders, null))).toBe(true);
    expect(isNoMatchValid(tallyOrders([ask("s1", 5n * USDC, 10n)], null))).toBe(true);
  });
  it("dust goes to lower asks when no ask sits at p* (spec gap)", () => {
    idx = 0;
    const orders = [ask("s1", 1n * USDC, 5n), bidO("b1", 2n * USDC, 3n), bidO("b2", 2n * USDC, 3n)];
    const p = findWindowClearingPrice(orders)!;
    expect(p).toBe(2n * USDC);
    const c = finalizeWindow(tallyOrders(orders, p), p);
    expect(c).toMatchObject({ kind: "supply_limited", matchedUnits: 5n, R: 5n, dAt: 6n });
    const f = Object.fromEntries(computeFills(orders, c, 100).map((x) => [x.owner, x]));
    expect(f["b1"]!.fill).toBe(2n);
    expect(f["b2"]!.fill).toBe(2n);
    expect(f["s1"]).toMatchObject({ fill: 4n, refund: 1n, cost: 8n * USDC });
  });
  it("unrevealed and invalid orders are ignored and fully refunded", () => {
    idx = 0;
    const orders = [ask("s1", 2n * USDC, 10n), bidO("b1", 2n * USDC, 10n), { ...bidO("b2", 9n * USDC, 10n), revealed: false }, ask("s2", 1n * USDC, 50n, 5n)];
    expect(orders[3]!.valid).toBe(false);
    const p = findWindowClearingPrice(orders)!;
    expect(p).toBe(2n * USDC);
    const fills = computeFills(orders, finalizeWindow(tallyOrders(orders, p), p), 100);
    const f = Object.fromEntries(fills.map((x) => [x.owner, x]));
    expect(f["b2"]).toMatchObject({ fill: 0n, cost: 0n, fee: 0n, refund: orders[2]!.escrow });
    expect(f["s2"]).toMatchObject({ fill: 0n, refund: 5n });
    expect(f["b1"]!.fill).toBe(10n);
  });
});

describe("clearing (reference extension: demand-limited crossing)", () => {
  it("more supply than demand at every price still clears: the spec alone would be stuck", () => {
    idx = 0;
    const orders = [ask("s1", 8n * USDC, 5n), bidO("b1", 10n * USDC, 1n)];
    expect(classifyWindowPrice(tallyOrders(orders, 8n * USDC))).toBe("demand_limited");
    expect(classifyWindowPrice(tallyOrders(orders, 10n * USDC))).toBeNull();
    expect(isNoMatchValid(tallyOrders(orders, null))).toBe(false); // spec: NO_MATCH invalid, no valid price → stuck
    const p = findWindowClearingPrice(orders)!;
    expect(p).toBe(8n * USDC);
    const c = finalizeWindow(tallyOrders(orders, p), p);
    expect(c).toMatchObject({ kind: "demand_limited", matchedUnits: 1n, Rs: 1n, sAt: 5n });
    const fills = computeFills(orders, c, 100);
    const f = Object.fromEntries(fills.map((x) => [x.owner, x]));
    expect(f["b1"]).toMatchObject({ fill: 1n, cost: 8n * USDC, fee: 80_000n, refund: orders[1]!.escrow - 8n * USDC - 80_000n });
    expect(f["s1"]).toMatchObject({ fill: 1n, cost: 8n * USDC, refund: 4n });
  });
  it("marginal asks pro rata; dust cut from the bids at p*", () => {
    idx = 0;
    const orders = [ask("s1", 9n * USDC, 7n), ask("s2", 9n * USDC, 5n), ask("s3", 8n * USDC, 2n), bidO("b1", 9n * USDC, 3n), bidO("b2", 9n * USDC, 4n)];
    const p = findWindowClearingPrice(orders)!;
    expect(p).toBe(9n * USDC);
    const c = finalizeWindow(tallyOrders(orders, p), p);
    expect(c).toMatchObject({ kind: "demand_limited", matchedUnits: 7n, Rs: 5n, sAt: 12n });
    const f = Object.fromEntries(computeFills(orders, c, 100).map((x) => [x.owner, x]));
    expect(f["s3"]!.fill).toBe(2n);
    expect(f["s1"]!.fill).toBe(2n); // floor(5 × 7 / 12)
    expect(f["s2"]!.fill).toBe(2n); // floor(5 × 5 / 12)
    // 7 − 6 = 1 unit of demand cannot be served: cut from the bid at p* with the highest reveal index
    expect(f["b2"]!.fill).toBe(3n);
    expect(f["b1"]!.fill).toBe(3n);
  });
});

const orderArb = fc.record({
  side: fc.constantFrom(OrderSide.Bid, OrderSide.Ask),
  price: fc.bigInt({ min: 1n, max: 4n }),
  quantity: fc.bigInt({ min: 1n, max: 9n }),
  revealed: fc.boolean(),
});

describe("properties", () => {
  it("exactly one valid price or NO_MATCH for any order book; units bought == units sold ≤ min(S, D); escrow conserved", () => {
    fc.assert(
      fc.property(fc.array(orderArb, { minLength: 0, maxLength: 10 }), (raw) => {
        const orders: WindowOrder[] = raw.map((o, i) => {
          const escrow = o.side === OrderSide.Ask ? o.quantity : requiredBidEscrow(o.price, o.quantity, 100);
          return { owner: `w${i}`, side: o.side, escrow, revealed: o.revealed, valid: o.revealed, price: o.price, quantity: o.quantity, revealIndex: i };
        });
        const prices = [1n, 2n, 3n, 4n];
        const valid = prices.filter((p) => classifyWindowPrice(tallyOrders(orders, p)) !== null);
        const noMatch = isNoMatchValid(tallyOrders(orders, null));
        expect(valid.length + (noMatch ? 1 : 0)).toBe(1);
        const p = findWindowClearingPrice(orders);
        if (p === null) return;
        const t = tallyOrders(orders, p);
        const c = finalizeWindow(t, p);
        const fills = computeFills(orders, c, 100);
        const bought = fills.filter((f) => f.side === OrderSide.Bid).reduce((a, f) => a + f.fill, 0n);
        const sold = fills.filter((f) => f.side === OrderSide.Ask).reduce((a, f) => a + f.fill, 0n);
        expect(bought).toBe(sold);
        const S = t.sBelow + t.sAt;
        const D = t.dAbove + t.dAt;
        expect(bought <= (S < D ? S : D)).toBe(true);
        expect(c.matchedUnits).toBe(S < D ? S : D);
        for (const f of fills) {
          const o = orders[Number(f.owner.slice(1))]!;
          if (f.side === OrderSide.Bid) {
            expect(f.cost + f.fee + f.refund).toBe(o.escrow);
            expect(f.fill <= o.quantity).toBe(true);
            if (!o.revealed || o.price < p) expect(f.fill).toBe(0n);
            if (o.revealed && o.price > p && c.kind === "supply_limited") expect(f.fill).toBe(o.quantity);
          } else {
            expect(f.fill + f.refund).toBe(o.escrow);
            if (!o.revealed || o.price > p) expect(f.fill).toBe(0n);
            if (o.revealed && o.price < p && c.kind === "demand_limited") expect(f.fill).toBe(o.quantity);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });
});

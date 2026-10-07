/**
 * Transfer window: quarterly call auction (SPEC §7, brief D9).
 *
 * The spec defines the clearing price through the *supply-limited* crossing (`d_above < S ≤ D`,
 * every unit offered at or below p* sells). That rule has no solution when sellers offer more
 * units than buyers want at every price (and `NO_MATCH` is then also invalid because
 * `max_bid ≥ min_ask`), so the reference adds the symmetric *demand-limited* branch
 * (`s_below ≤ D < S`): matched volume is `min(S, D)` and the marginal side is filled pro rata.
 * Exactly one candidate price (or `NO_MATCH`) is valid for any order book (see tests). The
 * supply-limited path is byte-for-byte the spec; see `docs/assumptions/track-a.md`.
 */
import { BPS_DENOMINATOR, OrderSide, mulDiv } from "@merces/sdk";

export interface WindowOrder {
  owner: string;
  side: OrderSide;
  /** stablecoin for bids, units for asks */
  escrow: bigint;
  revealed: boolean;
  valid: boolean;
  price: bigint;
  quantity: bigint;
  revealIndex: number;
}

export interface WindowRules {
  unitsOutstanding: bigint;
  walletCapBps: number;
  windowFeeBps: number;
}

/** `wallet_cap_units = floor(units_outstanding × wallet_cap_bps / 10000)` */
export function walletCapUnits(unitsOutstanding: bigint, walletCapBps: number): bigint {
  return mulDiv(unitsOutstanding, BigInt(walletCapBps), BPS_DENOMINATOR);
}

export function requiredBidEscrow(price: bigint, quantity: bigint, windowFeeBps: number): bigint {
  const cost = price * quantity;
  return cost + mulDiv(cost, BigInt(windowFeeBps), BPS_DENOMINATOR);
}

/** Validity at reveal (SPEC §7 `reveal_order`). `ownerBalance` is the bidder's current unit balance. */
export function isOrderValid(side: OrderSide, price: bigint, quantity: bigint, escrow: bigint, ownerBalance: bigint, rules: WindowRules): boolean {
  if (price < 1n || quantity < 1n) return false;
  if (side === OrderSide.Ask) return quantity <= escrow;
  const cap = walletCapUnits(rules.unitsOutstanding, rules.walletCapBps);
  const room = cap > ownerBalance ? cap - ownerBalance : 0n;
  return escrow >= requiredBidEscrow(price, quantity, rules.windowFeeBps) && quantity <= room;
}

export interface WindowTally {
  dAbove: bigint;
  dAt: bigint;
  sBelow: bigint;
  sAt: bigint;
  maxBid: bigint | null;
  minAsk: bigint | null;
  validOrders: number;
}

export function tallyOrders(orders: Iterable<WindowOrder>, clearingPrice: bigint | null): WindowTally {
  const t: WindowTally = { dAbove: 0n, dAt: 0n, sBelow: 0n, sAt: 0n, maxBid: null, minAsk: null, validOrders: 0 };
  for (const o of orders) {
    if (!o.revealed || !o.valid) continue;
    t.validOrders++;
    if (o.side === OrderSide.Bid) {
      if (t.maxBid === null || o.price > t.maxBid) t.maxBid = o.price;
      if (clearingPrice !== null) {
        if (o.price > clearingPrice) t.dAbove += o.quantity;
        else if (o.price === clearingPrice) t.dAt += o.quantity;
      }
    } else {
      if (t.minAsk === null || o.price < t.minAsk) t.minAsk = o.price;
      if (clearingPrice !== null) {
        if (o.price < clearingPrice) t.sBelow += o.quantity;
        else if (o.price === clearingPrice) t.sAt += o.quantity;
      }
    }
  }
  return t;
}

/** NO_MATCH is valid iff `max_bid < min_ask` or one side has no valid orders. */
export function isNoMatchValid(t: WindowTally): boolean {
  return t.maxBid === null || t.minAsk === null || t.maxBid < t.minAsk;
}

export type ClearingKind = "supply_limited" | "demand_limited";

/**
 * SPEC §7 supply-limited rule: `S > 0`, `d_above < S`, `S ≤ D`, and (`s_at > 0` or `d_at > 0`).
 * Reference extension (demand-limited): `D > 0`, `s_below ≤ D`, `D < S`, same revealed-price rule
 * (non-strict on `s_below` so that a book whose supply below p* exactly equals demand still clears).
 */
export function classifyWindowPrice(t: WindowTally): ClearingKind | null {
  const S = t.sBelow + t.sAt;
  const D = t.dAbove + t.dAt;
  if (!(t.sAt > 0n || t.dAt > 0n)) return null;
  if (S > 0n && t.dAbove < S && S <= D) return "supply_limited";
  if (D > 0n && t.sBelow <= D && D < S) return "demand_limited";
  return null;
}

/** The spec's rule only (used by the vectors, which stay inside the spec). */
export function isWindowPriceValid(t: WindowTally): boolean {
  return classifyWindowPrice(t) === "supply_limited";
}

export interface WindowClearing {
  clearingPrice: bigint;
  kind: ClearingKind;
  matchedUnits: bigint;
  /** supply-limited: units for the bids at p* (`S − d_above`); demand-limited: 0 */
  R: bigint;
  dAt: bigint;
  /** demand-limited: units for the asks at p* (`D − s_below`); supply-limited: 0 */
  Rs: bigint;
  sAt: bigint;
}

export function finalizeWindow(t: WindowTally, clearingPrice: bigint): WindowClearing {
  const kind = classifyWindowPrice(t);
  if (kind === null) throw new Error("InvalidWindowPrice");
  const S = t.sBelow + t.sAt;
  const D = t.dAbove + t.dAt;
  if (kind === "supply_limited") return { clearingPrice, kind, matchedUnits: S, R: S - t.dAbove, dAt: t.dAt, Rs: 0n, sAt: t.sAt };
  return { clearingPrice, kind, matchedUnits: D, R: 0n, dAt: t.dAt, Rs: D - t.sBelow, sAt: t.sAt };
}

/** The unique crossing price, or null when NO_MATCH is the right proposal. Throws if neither exists. */
export function findWindowClearingPrice(orders: WindowOrder[]): bigint | null {
  const prices = [...new Set(orders.filter((o) => o.revealed && o.valid).map((o) => o.price))];
  const matches = prices.filter((p) => classifyWindowPrice(tallyOrders(orders, p)) !== null);
  if (matches.length > 1) throw new Error(`crossing price not unique: ${matches.length}`);
  if (matches.length === 1) return matches[0]!;
  if (!isNoMatchValid(tallyOrders(orders, null))) throw new Error("no crossing price and NO_MATCH invalid");
  return null;
}

export interface OrderFill {
  owner: string;
  side: OrderSide;
  fill: bigint;
  /** stablecoin paid by a buyer (p* × fill) or received by a seller */
  cost: bigint;
  fee: bigint;
  /** stablecoin returned to a bidder, or units returned to an asker */
  refund: bigint;
}

/**
 * Fills for every order plus the dust pass. Supply-limited (SPEC §7 `process_order`): bids above
 * p* fill fully, bids at p* get `floor(R × q / d_at)`, asks at or below p* sell everything except
 * the unmatched remainder `U`, which goes back to the asks at p* in descending reveal-index order —
 * and, when those do not hold enough units (no ask sits exactly at p*), on to the next lower ask
 * price, again in descending reveal-index order (reference generalization of the spec's rule).
 * Demand-limited (reference extension): mirror image — asks at p* get `floor(Rs × q / s_at)`,
 * bids at or above p* buy everything except `U`, which is cut from the bids at p* (then bids
 * above p*) in descending reveal-index order.
 */
export function computeFills(orders: WindowOrder[], c: WindowClearing, windowFeeBps: number): OrderFill[] {
  const live = (o: WindowOrder) => o.revealed && o.valid;
  const bidFill = new Map<WindowOrder, bigint>();
  const askFill = new Map<WindowOrder, bigint>();
  for (const o of orders) {
    if (o.side === OrderSide.Bid) {
      let f = 0n;
      if (live(o)) {
        if (o.price > c.clearingPrice) f = o.quantity;
        else if (o.price === c.clearingPrice) f = c.kind === "supply_limited" ? mulDiv(c.R, o.quantity, c.dAt) : o.quantity;
      }
      bidFill.set(o, f);
    } else {
      let f = 0n;
      if (live(o)) {
        if (o.price < c.clearingPrice) f = o.quantity;
        else if (o.price === c.clearingPrice) f = c.kind === "supply_limited" ? o.quantity : mulDiv(c.Rs, o.quantity, c.sAt);
      }
      askFill.set(o, f);
    }
  }
  const sum = (m: Map<WindowOrder, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);
  if (c.kind === "supply_limited") {
    let U = c.matchedUnits - sum(bidFill);
    if (U < 0n) throw new Error("bid fills exceed matched units");
    const marginal = orders
      .filter((o) => o.side === OrderSide.Ask && live(o) && o.price <= c.clearingPrice)
      .sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : b.revealIndex - a.revealIndex));
    for (const o of marginal) {
      if (U === 0n) break;
      const f = askFill.get(o)!;
      const back = f < U ? f : U;
      askFill.set(o, f - back);
      U -= back;
    }
    if (U !== 0n) throw new Error("dust could not be returned");
  } else {
    let U = c.matchedUnits - sum(askFill);
    if (U < 0n) throw new Error("ask fills exceed matched units");
    const cut = orders
      .filter((o) => o.side === OrderSide.Bid && live(o) && o.price >= c.clearingPrice)
      .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : b.revealIndex - a.revealIndex));
    for (const o of cut) {
      if (U === 0n) break;
      const f = bidFill.get(o)!;
      const back = f < U ? f : U;
      bidFill.set(o, f - back);
      U -= back;
    }
    if (U !== 0n) throw new Error("dust could not be returned");
  }
  if (sum(bidFill) !== sum(askFill)) throw new Error("units bought != units sold");
  const fills: OrderFill[] = [];
  for (const o of orders) {
    if (o.side === OrderSide.Bid) {
      const fill = bidFill.get(o)!;
      const cost = c.clearingPrice * fill;
      const fee = mulDiv(cost, BigInt(windowFeeBps), BPS_DENOMINATOR);
      fills.push({ owner: o.owner, side: OrderSide.Bid, fill, cost, fee, refund: o.escrow - cost - fee });
    } else {
      const fill = askFill.get(o)!;
      fills.push({ owner: o.owner, side: OrderSide.Ask, fill, cost: c.clearingPrice * fill, fee: 0n, refund: o.escrow - fill });
    }
  }
  return fills;
}

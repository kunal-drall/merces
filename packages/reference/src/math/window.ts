/**
 * Transfer window: quarterly call auction (SPEC v1.1 §7, brief D9). Two-branch clearing
 * (supply-limited or demand-limited) so a crossing price always exists when `max_bid ≥ min_ask`,
 * first-come fills at the margin (ascending reveal index: exact, dust-free, always solvent), and one
 * order per wallet.
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

/** Validity at reveal (never reverts; recorded on the order). `ownerBalance` is the bidder's unit balance. */
export function isOrderValid(side: OrderSide, price: bigint, quantity: bigint, escrow: bigint, ownerBalance: bigint, rules: WindowRules): boolean {
  if (price < 1n || quantity < 1n) return false;
  if (side === OrderSide.Ask) return quantity <= escrow;
  return escrow >= requiredBidEscrow(price, quantity, rules.windowFeeBps) && ownerBalance + quantity <= walletCapUnits(rules.unitsOutstanding, rules.walletCapBps);
}

export interface WindowTally {
  dAbove: bigint;
  dAt: bigint;
  sBelow: bigint;
  sAt: bigint;
  maxBid: bigint | null;
  minAsk: bigint | null;
  validCount: number;
}

export function tallyOrders(orders: Iterable<WindowOrder>, clearingPrice: bigint | null): WindowTally {
  const t: WindowTally = { dAbove: 0n, dAt: 0n, sBelow: 0n, sAt: 0n, maxBid: null, minAsk: null, validCount: 0 };
  for (const o of orders) {
    if (!o.revealed || !o.valid) continue;
    t.validCount++;
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

/** NO_MATCH is valid iff `valid_count == 0` or `max_bid < min_ask` (one side empty counts as no crossing). */
export function isNoMatchValid(t: WindowTally): boolean {
  return t.validCount === 0 || t.maxBid === null || t.minAsk === null || t.maxBid < t.minAsk;
}

export type ClearingBranch = "SupplyLimited" | "DemandLimited";

/**
 * (A) supply-limited: `S > 0 && d_above < S && S ≤ D`; (B) demand-limited: `D > 0 && s_below ≤ D && D < S`;
 * `p*` must be a revealed valid price (`d_at > 0 || s_at > 0`). Returns the branch or null.
 */
export function classifyWindowPrice(t: WindowTally): ClearingBranch | null {
  const S = t.sBelow + t.sAt;
  const D = t.dAbove + t.dAt;
  if (!(t.sAt > 0n || t.dAt > 0n)) return null;
  if (S > 0n && t.dAbove < S && S <= D) return "SupplyLimited";
  if (D > 0n && t.sBelow <= D && D < S) return "DemandLimited";
  return null;
}

export interface WindowClearing {
  clearingPrice: bigint;
  branch: ClearingBranch;
  matchedUnits: bigint;
  /** units left for the marginal side (`S − d_above` in A, `D − s_below` in B) */
  marginalRemaining: bigint;
  S: bigint;
  D: bigint;
}

export type WindowFinalize = { kind: "settled"; clearing: WindowClearing } | { kind: "nomatch" } | { kind: "rejected"; reason: "InvalidWindowPrice" };

/** `finalize_window`: a wrong proposal is a rejection, not a revert. `clearingPrice === null` means NO_MATCH. */
export function finalizeWindow(t: WindowTally, clearingPrice: bigint | null): WindowFinalize {
  if (clearingPrice === null) return isNoMatchValid(t) ? { kind: "nomatch" } : { kind: "rejected", reason: "InvalidWindowPrice" };
  const branch = classifyWindowPrice(t);
  if (branch === null) return { kind: "rejected", reason: "InvalidWindowPrice" };
  const S = t.sBelow + t.sAt;
  const D = t.dAbove + t.dAt;
  return branch === "SupplyLimited"
    ? { kind: "settled", clearing: { clearingPrice, branch, matchedUnits: S, marginalRemaining: S - t.dAbove, S, D } }
    : { kind: "settled", clearing: { clearingPrice, branch, matchedUnits: D, marginalRemaining: D - t.sBelow, S, D } };
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
  /** a filled bid cancelled because the buyer was not allowlisted at fill time */
  cancelled: boolean;
}

/**
 * Fills for every order (SPEC v1.1 §7 `process_order`): full side fills in full, losing side 0,
 * the marginal side first-come in ascending reveal index with `fill = min(quantity, remaining)`.
 * `isAllowed` cancels a filled bid whose buyer is no longer allowlisted (full refund); the units
 * it would have bought stay unmatched and return to sellers, taken back from the marginal asks
 * (descending reveal index) first, then from asks below p*.
 */
export function computeFills(orders: WindowOrder[], c: WindowClearing, windowFeeBps: number, isAllowed: (owner: string) => boolean = () => true): OrderFill[] {
  const live = (o: WindowOrder) => o.revealed && o.valid;
  const fillOf = new Map<WindowOrder, bigint>();
  const supply = c.branch === "SupplyLimited";
  // non-marginal sides
  for (const o of orders) {
    if (!live(o)) {
      fillOf.set(o, 0n);
      continue;
    }
    if (o.side === OrderSide.Bid) {
      if (o.price > c.clearingPrice) fillOf.set(o, o.quantity);
      else if (o.price === c.clearingPrice) fillOf.set(o, supply ? -1n : o.quantity); // -1: marginal, decided below
      else fillOf.set(o, 0n);
    } else {
      if (o.price < c.clearingPrice) fillOf.set(o, o.quantity);
      else if (o.price === c.clearingPrice) fillOf.set(o, supply ? o.quantity : -1n);
      else fillOf.set(o, 0n);
    }
  }
  // marginal side: first come in ascending reveal index
  const marginalSide = supply ? OrderSide.Bid : OrderSide.Ask;
  const marginal = orders.filter((o) => live(o) && o.side === marginalSide && o.price === c.clearingPrice).sort((a, b) => a.revealIndex - b.revealIndex);
  let remaining = c.marginalRemaining;
  for (const o of marginal) {
    const f = o.quantity < remaining ? o.quantity : remaining;
    fillOf.set(o, f);
    remaining -= f;
  }
  if (remaining !== 0n) throw new Error("marginal remainder not exhausted");
  // allowlist re-check on buyers: cancelled fills return to sellers
  const cancelled = new Set<WindowOrder>();
  let returned = 0n;
  for (const o of orders) {
    if (o.side !== OrderSide.Bid) continue;
    const f = fillOf.get(o)!;
    if (f > 0n && !isAllowed(o.owner)) {
      cancelled.add(o);
      returned += f;
      fillOf.set(o, 0n);
    }
  }
  if (returned > 0n) {
    const takeBack = orders
      .filter((o) => live(o) && o.side === OrderSide.Ask && o.price <= c.clearingPrice)
      .sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : b.revealIndex - a.revealIndex));
    for (const o of takeBack) {
      if (returned === 0n) break;
      const f = fillOf.get(o)!;
      const back = f < returned ? f : returned;
      fillOf.set(o, f - back);
      returned -= back;
    }
    if (returned !== 0n) throw new Error("cancelled units could not be returned");
  }
  const bought = orders.filter((o) => o.side === OrderSide.Bid).reduce((a, o) => a + fillOf.get(o)!, 0n);
  const sold = orders.filter((o) => o.side === OrderSide.Ask).reduce((a, o) => a + fillOf.get(o)!, 0n);
  if (bought !== sold) throw new Error(`units bought ${bought} != units sold ${sold}`);
  return orders.map((o) => {
    const fill = fillOf.get(o)!;
    if (o.side === OrderSide.Bid) {
      const cost = c.clearingPrice * fill;
      const fee = mulDiv(cost, BigInt(windowFeeBps), BPS_DENOMINATOR);
      return { owner: o.owner, side: o.side, fill, cost, fee, refund: o.escrow - cost - fee, cancelled: cancelled.has(o) };
    }
    return { owner: o.owner, side: o.side, fill, cost: c.clearingPrice * fill, fee: 0n, refund: o.escrow - fill, cancelled: false };
  });
}

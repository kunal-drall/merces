/**
 * Sealed-bid uniform-price auction (SPEC §5.1–§5.2).
 */
import { BPS_DENOMINATOR, mulDiv } from "@merces/sdk";

export interface AuctionRules {
  unitsOffered: bigint;
  reservePrice: bigint;
  minRaise: bigint;
  walletCapBps: number;
  auctionFeeBps: number;
  nonRevealChargeBps: number;
}

export interface RevealedBid {
  price: bigint;
  quantity: bigint;
  escrow: bigint;
  valid: boolean;
  revealIndex: number;
}

/** `wallet_cap_units_at_auction = floor(units_offered × wallet_cap_bps / 10000)` */
export function walletCapUnitsAtAuction(unitsOffered: bigint, walletCapBps: number): bigint {
  return mulDiv(unitsOffered, BigInt(walletCapBps), BPS_DENOMINATOR);
}

/** `required_escrow(p, q) = p×q + floor(p×q × auction_fee_bps / 10000)` */
export function requiredEscrow(price: bigint, quantity: bigint, auctionFeeBps: number): bigint {
  const cost = price * quantity;
  return cost + mulDiv(cost, BigInt(auctionFeeBps), BPS_DENOMINATOR);
}

/** Validity evaluated at reveal (SPEC §5.2 `reveal_bid`). */
export function isBidValid(price: bigint, quantity: bigint, escrow: bigint, rules: AuctionRules): boolean {
  return (
    price >= rules.reservePrice &&
    quantity >= 1n &&
    quantity <= walletCapUnitsAtAuction(rules.unitsOffered, rules.walletCapBps) &&
    escrow >= requiredEscrow(price, quantity, rules.auctionFeeBps)
  );
}

export interface Tally {
  qAbove: bigint;
  qAt: bigint;
  /** lowest valid revealed price, or null when there is no valid bid */
  minValidPrice: bigint | null;
  talliedCount: number;
}

/** One tally pass over revealed bids for a proposed clearing price. */
export function tallyBids(bids: Iterable<RevealedBid>, clearingPrice: bigint): Tally {
  let qAbove = 0n;
  let qAt = 0n;
  let minValidPrice: bigint | null = null;
  let talliedCount = 0;
  for (const b of bids) {
    talliedCount++;
    if (!b.valid) continue;
    if (b.price > clearingPrice) qAbove += b.quantity;
    else if (b.price === clearingPrice) qAt += b.quantity;
    if (minValidPrice === null || b.price < minValidPrice) minValidPrice = b.price;
  }
  return { qAbove, qAt, minValidPrice, talliedCount };
}

/**
 * Validity of a clearing-price proposal (SPEC §5.2 `finalize_settlement`): (a) `q_at > 0`,
 * (b) `q_above < N`, (c) `D ≥ N` or (`D < N` and `min_valid_price == p*`).
 */
export function isClearingPriceValid(t: Tally, unitsOffered: bigint, clearingPrice: bigint): boolean {
  const d = t.qAbove + t.qAt;
  if (t.qAt <= 0n) return false;
  if (t.qAbove >= unitsOffered) return false;
  return d >= unitsOffered || t.minValidPrice === clearingPrice;
}

export interface SettlementOutcome {
  /** units for the marginal bids: `R = min(N − q_above, q_at)` */
  R: bigint;
  qAt: bigint;
  qAbove: bigint;
  unitsSoldUpper: bigint;
  proceedsUpper: bigint;
  /** `p* × (q_above + R) < min_raise` → raise fails */
  failed: boolean;
}

/**
 * Finalize with a valid proposal; throws `InvalidClearingPrice` otherwise. When there are no
 * valid revealed bids at all the proposal `0` is accepted and the raise fails (recorded
 * assumption; the spec's validity rule (a) could otherwise never be met).
 */
export function finalizeSettlement(t: Tally, rules: AuctionRules, clearingPrice: bigint): SettlementOutcome {
  if (t.minValidPrice === null) {
    if (clearingPrice !== 0n) throw new Error("InvalidClearingPrice");
    return { R: 0n, qAt: 0n, qAbove: 0n, unitsSoldUpper: 0n, proceedsUpper: 0n, failed: true };
  }
  if (!isClearingPriceValid(t, rules.unitsOffered, clearingPrice)) throw new Error("InvalidClearingPrice");
  const R = minBig(rules.unitsOffered - t.qAbove, t.qAt);
  const unitsSoldUpper = t.qAbove + R;
  const proceedsUpper = clearingPrice * unitsSoldUpper;
  return { R, qAt: t.qAt, qAbove: t.qAbove, unitsSoldUpper, proceedsUpper, failed: proceedsUpper < rules.minRaise };
}

/** `alloc_i = floor(R × q_i / q_at)` for a bid exactly at the clearing price. */
export function marginalAllocation(R: bigint, quantity: bigint, qAt: bigint): bigint {
  return mulDiv(R, quantity, qAt);
}

export interface BidOutcome {
  alloc: bigint;
  cost: bigint;
  fee: bigint;
  refund: bigint;
  /** non-reveal charge to the fee collector */
  charge: bigint;
}

export interface SettledState {
  failed: boolean;
  clearingPrice: bigint;
  R: bigint;
  qAt: bigint;
}

/** Outcome of processing one bid after settlement (SPEC §5.2 `claim_win`). */
export function processBid(bid: { escrow: bigint; revealed: boolean; valid: boolean; price: bigint; quantity: bigint }, s: SettledState, rules: AuctionRules): BidOutcome {
  if (s.failed) return { alloc: 0n, cost: 0n, fee: 0n, refund: bid.escrow, charge: 0n };
  if (!bid.revealed) {
    const charge = mulDiv(bid.escrow, BigInt(rules.nonRevealChargeBps), BPS_DENOMINATOR);
    return { alloc: 0n, cost: 0n, fee: 0n, refund: bid.escrow - charge, charge };
  }
  let alloc = 0n;
  if (bid.valid) {
    if (bid.price > s.clearingPrice) alloc = bid.quantity;
    else if (bid.price === s.clearingPrice) alloc = marginalAllocation(s.R, bid.quantity, s.qAt);
  }
  if (alloc === 0n) return { alloc: 0n, cost: 0n, fee: 0n, refund: bid.escrow, charge: 0n };
  const cost = s.clearingPrice * alloc;
  const fee = mulDiv(cost, BigInt(rules.auctionFeeBps), BPS_DENOMINATOR);
  const refund = bid.escrow - cost - fee;
  if (refund < 0n) throw new Error("escrow below cost + fee (validity rule violated)");
  return { alloc, cost, fee, refund, charge: 0n };
}

/**
 * The unique clearing price a keeper should propose: the single revealed valid price that passes
 * {@link isClearingPriceValid}. Returns `0n` when no valid bids exist (the raise then fails) and
 * throws if no price passes (cannot happen with at least one valid bid, see tests).
 */
export function findClearingPrice(bids: RevealedBid[], unitsOffered: bigint): bigint {
  const prices = [...new Set(bids.filter((b) => b.valid).map((b) => b.price))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length === 0) return 0n;
  const matches = prices.filter((p) => isClearingPriceValid(tallyBids(bids, p), unitsOffered, p));
  if (matches.length !== 1) throw new Error(`expected exactly one valid clearing price, found ${matches.length}`);
  return matches[0]!;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

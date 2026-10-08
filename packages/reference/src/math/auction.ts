/**
 * Sealed-bid uniform-price auction (SPEC v1.1 §5.1–§5.2): one-round-at-a-time settlement with
 * proposer claims, exact one-pass results, rejections instead of reverts, and two-phase bid
 * processing (`process_bid` to protocol accounts, `deliver_bid` to the bidder).
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

/** `wallet_cap_units_at_auction = floor(units_offered × wallet_cap_bps / 10000)` (≥ 1 by the creation rule) */
export function walletCapUnitsAtAuction(unitsOffered: bigint, walletCapBps: number): bigint {
  return mulDiv(unitsOffered, BigInt(walletCapBps), BPS_DENOMINATOR);
}

/** `required_escrow(p, q) = p×q + floor(p×q × auction_fee_bps / 10000)` */
export function requiredEscrow(price: bigint, quantity: bigint, auctionFeeBps: number): bigint {
  const cost = price * quantity;
  return cost + mulDiv(cost, BigInt(auctionFeeBps), BPS_DENOMINATOR);
}

/** Validity evaluated at reveal (never reverts; recorded on the bid). */
export function isBidValid(price: bigint, quantity: bigint, escrow: bigint, rules: AuctionRules): boolean {
  return (
    price >= rules.reservePrice &&
    quantity >= 1n &&
    quantity <= walletCapUnitsAtAuction(rules.unitsOffered, rules.walletCapBps) &&
    escrow >= requiredEscrow(price, quantity, rules.auctionFeeBps)
  );
}

/** A settlement proposal: the price plus the proposer's claims and the derived `r_claim`. */
export interface Proposal {
  clearingPrice: bigint;
  qAboveClaim: bigint;
  qAtClaim: bigint;
  /** `min(units_offered − q_above_claim, q_at_claim)`, saturating at 0 */
  rClaim: bigint;
}

export function beginSettlement(unitsOffered: bigint, clearingPrice: bigint, qAboveClaim: bigint, qAtClaim: bigint): Proposal {
  const room = unitsOffered > qAboveClaim ? unitsOffered - qAboveClaim : 0n;
  return { clearingPrice, qAboveClaim, qAtClaim, rClaim: room < qAtClaim ? room : qAtClaim };
}

export interface Tally {
  qAbove: bigint;
  qAt: bigint;
  /** Σ floor(r_claim × q_i / q_at_claim) over valid bids exactly at the price */
  allocSum: bigint;
  /** lowest valid revealed price, or null when there is no valid bid */
  minValidPrice: bigint | null;
  talliedCount: number;
}

/** One tally pass over the revealed bids for a proposal (SPEC §5.2 `tally_bids`). */
export function tallyBids(bids: Iterable<RevealedBid>, proposal: Proposal): Tally {
  let qAbove = 0n;
  let qAt = 0n;
  let allocSum = 0n;
  let minValidPrice: bigint | null = null;
  let talliedCount = 0;
  for (const b of bids) {
    talliedCount++;
    if (!b.valid) continue;
    if (minValidPrice === null || b.price < minValidPrice) minValidPrice = b.price;
    if (b.price > proposal.clearingPrice) qAbove += b.quantity;
    else if (b.price === proposal.clearingPrice) {
      qAt += b.quantity;
      if (proposal.qAtClaim > 0n) allocSum += mulDiv(proposal.rClaim, b.quantity, proposal.qAtClaim);
    }
  }
  return { qAbove, qAt, allocSum, minValidPrice, talliedCount };
}

/**
 * Price validity (SPEC §5.2 step 3): (a) oversubscribed `q_at > 0 && q_above < N && q_above + q_at ≥ N`,
 * or (b) undersubscribed `q_above + q_at < N && min_valid_price == p*`.
 */
export function isClearingPriceValid(t: Pick<Tally, "qAbove" | "qAt" | "minValidPrice">, unitsOffered: bigint, clearingPrice: bigint): boolean {
  const d = t.qAbove + t.qAt;
  if (t.qAt > 0n && t.qAbove < unitsOffered && d >= unitsOffered) return true;
  return d < unitsOffered && t.minValidPrice === clearingPrice;
}

export type RejectionReason = "ClaimMismatch" | "InvalidClearingPrice";

export type FinalizeOutcome =
  | { kind: "failed"; reason: "NoValidBids" | "MinRaise"; clearingPrice: bigint; unitsSold: bigint; proceeds: bigint }
  | { kind: "rejected"; reason: RejectionReason }
  | { kind: "settled"; clearingPrice: bigint; R: bigint; qAt: bigint; qAbove: bigint; unitsSold: bigint; proceeds: bigint };

/** `finalize_settlement` (SPEC §5.2): never "reverts" on a wrong proposal — it returns a rejection. */
export function finalizeSettlement(t: Tally, validCount: number, rules: AuctionRules, p: Proposal): FinalizeOutcome {
  if (validCount === 0) return { kind: "failed", reason: "NoValidBids", clearingPrice: 0n, unitsSold: 0n, proceeds: 0n };
  if (t.qAbove !== p.qAboveClaim || t.qAt !== p.qAtClaim) return { kind: "rejected", reason: "ClaimMismatch" };
  if (!isClearingPriceValid(t, rules.unitsOffered, p.clearingPrice)) return { kind: "rejected", reason: "InvalidClearingPrice" };
  const unitsSold = t.qAbove + t.allocSum;
  const proceeds = p.clearingPrice * unitsSold;
  if (proceeds < rules.minRaise) return { kind: "failed", reason: "MinRaise", clearingPrice: p.clearingPrice, unitsSold, proceeds };
  return { kind: "settled", clearingPrice: p.clearingPrice, R: p.rClaim, qAt: t.qAt, qAbove: t.qAbove, unitsSold, proceeds };
}

/** `alloc_i = floor(R × q_i / q_at)` for a bid exactly at the clearing price. */
export function marginalAllocation(R: bigint, quantity: bigint, qAt: bigint): bigint {
  return mulDiv(R, quantity, qAt);
}

export interface BidOutcome {
  alloc: bigint;
  cost: bigint;
  fee: bigint;
  /** stablecoin owed back to the bidder, delivered by `deliver_bid` */
  pendingRefund: bigint;
  /** non-reveal charge to the fee collector (taken at processing) */
  charge: bigint;
}

export interface SettledState {
  failed: boolean;
  clearingPrice: bigint;
  R: bigint;
  qAt: bigint;
}

/** Outcome of `process_bid` (SPEC §5.2): what moves to protocol accounts and what the bidder is owed. */
export function processBid(bid: { escrow: bigint; revealed: boolean; valid: boolean; price: bigint; quantity: bigint }, s: SettledState, rules: AuctionRules): BidOutcome {
  if (s.failed) return { alloc: 0n, cost: 0n, fee: 0n, pendingRefund: bid.escrow, charge: 0n };
  if (!bid.revealed) {
    const charge = mulDiv(bid.escrow, BigInt(rules.nonRevealChargeBps), BPS_DENOMINATOR);
    return { alloc: 0n, cost: 0n, fee: 0n, pendingRefund: bid.escrow - charge, charge };
  }
  let alloc = 0n;
  if (bid.valid) {
    if (bid.price > s.clearingPrice) alloc = bid.quantity;
    else if (bid.price === s.clearingPrice) alloc = marginalAllocation(s.R, bid.quantity, s.qAt);
  }
  if (alloc === 0n) return { alloc: 0n, cost: 0n, fee: 0n, pendingRefund: bid.escrow, charge: 0n };
  const cost = s.clearingPrice * alloc;
  const fee = mulDiv(cost, BigInt(rules.auctionFeeBps), BPS_DENOMINATOR);
  const pendingRefund = bid.escrow - cost - fee;
  if (pendingRefund < 0n) throw new Error("escrow below cost + fee (validity rule violated)");
  return { alloc, cost, fee, pendingRefund, charge: 0n };
}

/** The tally totals a proposer should claim for a price (what an honest keeper computes off-chain). */
export function claimsFor(bids: Iterable<RevealedBid>, clearingPrice: bigint): { qAboveClaim: bigint; qAtClaim: bigint } {
  let qAboveClaim = 0n;
  let qAtClaim = 0n;
  for (const b of bids) {
    if (!b.valid) continue;
    if (b.price > clearingPrice) qAboveClaim += b.quantity;
    else if (b.price === clearingPrice) qAtClaim += b.quantity;
  }
  return { qAboveClaim, qAtClaim };
}

/**
 * The unique valid clearing price for a set of revealed bids, or null when no bid is valid (the
 * raise then fails under step 1 regardless of the proposal). Throws if no price passes — this
 * cannot happen with at least one valid bid (see tests).
 */
export function findClearingPrice(bids: RevealedBid[], unitsOffered: bigint): bigint | null {
  const prices = [...new Set(bids.filter((b) => b.valid).map((b) => b.price))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length === 0) return null;
  const matches = prices.filter((p) => isClearingPriceValid(tallyBids(bids, beginSettlement(unitsOffered, p, 0n, 0n)), unitsOffered, p));
  if (matches.length !== 1) throw new Error(`expected exactly one valid clearing price, found ${matches.length}`);
  return matches[0]!;
}

import { bpsOf, minBig } from '@merces/sdk';

/**
 * The interim auction family (S2 replaces it with Stage 1's multi-step settlement: pro-rata marginal fill, an over-cap
 * bid invalid at reveal). Unrevealed bids are refunded in full: the non-reveal charge is an owner hold and is not
 * modelled. The fee arithmetic is Stage 1's `bpsOf`.
 *
 * Sealed-bid uniform-price clearing (R4, C10). Pure and deterministic.
 *  - Bids below the reserve price are ignored.
 *  - Bids are filled from the highest price down; ties are broken by commit order (earlier first) (A-AUC-1).
 *  - Each wallet's allocation is capped at walletCapUnits (10% of the series, parameter).
 *  - The clearing price is the lowest price among (partially or fully) filled bids.
 *  - If total cleared units × clearing price < minimumRaise the auction fails and everyone is refunded.
 */
export interface RevealedBid {
  bidder: string;
  pricePerUnit: bigint;
  quantity: bigint;
  /** commit order, lower first */
  order: number;
}

export interface Allocation {
  bidder: string;
  units: bigint;
  /** cleared amount = units × clearingPrice */
  amount: bigint;
  fee: bigint;
}

export interface ClearingResult {
  success: boolean;
  clearingPrice: bigint;
  unitsSold: bigint;
  proceeds: bigint;
  totalFees: bigint;
  allocations: Allocation[];
  reason?: 'no-bids' | 'below-minimum-raise';
}

export function clearAuction(params: {
  bids: RevealedBid[];
  unitsOffered: bigint;
  reservePrice: bigint;
  minimumRaise: bigint;
  walletCapUnits: bigint;
  auctionFeeBps: bigint;
}): ClearingResult {
  const { unitsOffered, reservePrice, minimumRaise, walletCapUnits, auctionFeeBps } = params;
  if (unitsOffered < 0n) throw new RangeError('unitsOffered must be non-negative');
  const eligible = params.bids
    .filter((b) => b.pricePerUnit >= reservePrice && b.quantity > 0n)
    .sort((a, b) => (a.pricePerUnit === b.pricePerUnit ? a.order - b.order : a.pricePerUnit > b.pricePerUnit ? -1 : 1));

  let remaining = unitsOffered;
  const perWallet = new Map<string, bigint>();
  const filled: { bidder: string; units: bigint; price: bigint }[] = [];
  let clearingPrice = 0n;
  for (const b of eligible) {
    if (remaining === 0n) break;
    const already = perWallet.get(b.bidder) ?? 0n;
    const room = walletCapUnits > already ? walletCapUnits - already : 0n;
    const units = minBig(b.quantity, remaining, room);
    if (units === 0n) continue;
    remaining -= units;
    perWallet.set(b.bidder, already + units);
    filled.push({ bidder: b.bidder, units, price: b.pricePerUnit });
    clearingPrice = b.pricePerUnit;
  }
  const unitsSold = unitsOffered - remaining;
  if (unitsSold === 0n) {
    return { success: false, clearingPrice: 0n, unitsSold: 0n, proceeds: 0n, totalFees: 0n, allocations: [], reason: 'no-bids' };
  }
  const proceeds = unitsSold * clearingPrice;
  if (proceeds < minimumRaise) {
    return { success: false, clearingPrice, unitsSold, proceeds, totalFees: 0n, allocations: [], reason: 'below-minimum-raise' };
  }
  // Merge per bidder (a wallet may have several bids but one allocation).
  const merged = new Map<string, bigint>();
  for (const f of filled) merged.set(f.bidder, (merged.get(f.bidder) ?? 0n) + f.units);
  const allocations: Allocation[] = [...merged.entries()].map(([bidder, units]) => {
    const amount = units * clearingPrice;
    return { bidder, units, amount, fee: bpsOf(amount, auctionFeeBps) };
  });
  const totalFees = allocations.reduce((a, x) => a + x.fee, 0n);
  return { success: true, clearingPrice, unitsSold, proceeds, totalFees, allocations };
}

/** Maximum units one wallet may hold: floor(outstanding × capBps / 10000), at least 1 when outstanding > 0. */
export function walletCapUnits(unitsOutstanding: bigint, capBps: bigint): bigint {
  const cap = (unitsOutstanding * capBps) / 10_000n;
  return cap === 0n && unitsOutstanding > 0n ? 1n : cap;
}

/** Auction fee paid by a winning bidder on top of the cleared amount (1% by default, a series term). */
export function auctionFee(clearedAmount: bigint, feeBps: bigint): bigint {
  if (clearedAmount < 0n) throw new RangeError('clearedAmount must be non-negative');
  return bpsOf(clearedAmount, feeBps);
}

/** What a bidder must deposit at commit time to cover price × quantity plus the fee. */
export function bidDeposit(pricePerUnit: bigint, quantity: bigint, feeBps: bigint): bigint {
  const amount = pricePerUnit * quantity;
  return amount + bpsOf(amount, feeBps);
}

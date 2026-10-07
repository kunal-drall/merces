import { BPS, assertNonNegative, bpsOf } from './fixed.ts';

/** C5. Fees. Defaults are parameters fixed per series at creation (1% auction, 5% payout). */
export const DEFAULT_AUCTION_FEE_BPS = 100n;
export const DEFAULT_PAYOUT_FEE_BPS = 500n;

/** Auction fee paid by a winning bidder on top of the cleared amount. */
export function auctionFee(clearedAmount: bigint, feeBps: bigint): bigint {
  assertNonNegative(clearedAmount, 'clearedAmount');
  return bpsOf(clearedAmount, feeBps);
}

/** Payout fee taken from each gross payment when it enters the vault. Returns {fee, net}. */
export function payoutFee(gross: bigint, feeBps: bigint): { fee: bigint; net: bigint } {
  assertNonNegative(gross, 'gross');
  const fee = bpsOf(gross, feeBps);
  return { fee, net: gross - fee };
}

/** What a bidder must deposit at commit time to cover price × quantity plus the fee. */
export function bidDeposit(pricePerUnit: bigint, quantity: bigint, feeBps: bigint): bigint {
  const amount = pricePerUnit * quantity;
  return amount + bpsOf(amount, feeBps);
}

export { BPS };

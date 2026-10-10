import type { PoolClient } from '@merces/db';
import { enqueueOutbox } from '@merces/core';
import type { DomainEvent } from '@merces/domain';

/**
 * Chain events that notify people (E12). They are enqueued here, in the same transaction that projects the event
 * and advances the cursor, so a crash can neither lose a notice nor send it twice; whoever caused the event (a
 * keeper crank, a user's transaction) does not matter. The payload carries the event's chain and sequence, so two
 * identical transitions at different times are two notices, while a redelivered outbox row still dedupes.
 * The outbox row keeps the whole event payload, so the auction notices carry public onchain amounts (a delivered
 * refund, a raise's proceeds): none is income (S2 amendment L16). The notifications module whitelists what it stores and
 * renders (safeData: statuses, ids, dates and codes, never an amount).
 */
const CHAIN_NOTICES: Record<string, string> = {
  AuctionSettled: 'auction.settled',
  AuctionFailed: 'auction.failed',
  SettlementRejected: 'auction.settlement-rejected',
  RaiseMintFinalized: 'auction.mint-finalized',
  BidDelivered: 'bid.delivered',
  NonRevealCharged: 'bid.non-reveal-charged',
  StatusChanged: 'series.StatusChanged',
  FormalNoticeDue: 'series.FormalNoticeDue',
  ReleasesPaused: 'series.ReleasesPaused',
  ReleasesResumed: 'series.ReleasesResumed',
  PauseEnded: 'series.PauseEnded',
};

/**
 * A curve series' notices (S3 WP11; amendment M8), in place of the sealed-bid ones for the same event: completion
 * (`CurveGraduated`, Stage 1 `RaiseSettled` on a curve) is `curve.completed`, to the issuer and the holders, and stands
 * for the raise's mint notice (the curve has no bids to process, so `RaiseMintFinalized` notifies nobody); a redemption
 * (`RedemptionOpened`) is `curve.tender-open`, to the holders: a curve is redeemed by tender, staked units reserved and
 * units in wallets sharing a quota. Wallets that hold units without a position (they never staked) hear of both from the
 * keepers' reminders (`curve.stake-reminders`, `curve.tender-reminders`).
 */
const CURVE_NOTICES: Record<string, string | null> = {
  CurveGraduated: 'curve.completed',
  RaiseMintFinalized: null,
  RedemptionOpened: 'curve.tender-open',
};

/**
 * Fields a notice adds beside the event payload, for routing and rendering:
 * - `bid.delivered` and `bid.non-reveal-charged` go to the bidder's own account: `wallet` is the event's `bidder`;
 * - `auction.mint-finalized` names the raise's outcome: a settled raise sells at least one unit and a failed one
 *   finalizes its mint with (0, 0) (S2 D7), so `unitsSold` tells them apart.
 */
function routing(e: DomainEvent): Record<string, unknown> {
  const p = e.payload as Record<string, unknown>;
  if ((e.type === 'BidDelivered' || e.type === 'NonRevealCharged') && typeof p.bidder === 'string') return { wallet: p.bidder };
  if (e.type === 'RaiseMintFinalized') return { outcome: BigInt(String(p.unitsSold ?? '0')) > 0n ? 'settled' : 'failed' };
  return {};
}

/** Whether `seriesId` is a curve series, as projected (the event's own projection ran first, in this transaction). */
async function isCurve(client: PoolClient, seriesId: string | undefined): Promise<boolean> {
  if (!seriesId) return false;
  const r = await client.query<{ raise_style: string }>('select raise_style from series where series_id = $1', [seriesId]);
  return r.rows[0]?.raise_style === 'curve';
}

/**
 * Enqueue the notice for `e`, if it has one. A curve series' notice names its raise style (`raiseStyle: 'curve'`), so a
 * status change says what a curve holder sends (tender, not claimRedemption; nothing burns).
 */
export async function enqueueChainNotice(client: PoolClient, e: DomainEvent): Promise<void> {
  if (!(e.type in CHAIN_NOTICES) && !(e.type in CURVE_NOTICES)) return;
  const seriesId = (e.payload as { seriesId?: string }).seriesId;
  const curve = await isCurve(client, seriesId);
  const kind = curve && e.type in CURVE_NOTICES ? CURVE_NOTICES[e.type] : CHAIN_NOTICES[e.type];
  if (!kind) return;
  await enqueueOutbox(client, 'notification', { kind, seriesId, chain: e.chain, seq: e.seq, txId: e.txId, ...routing(e), ...(curve ? { raiseStyle: 'curve' } : {}), payload: e.payload });
}

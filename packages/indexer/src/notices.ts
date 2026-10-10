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
  StatusChanged: 'series.StatusChanged',
  FormalNoticeDue: 'series.FormalNoticeDue',
  ReleasesPaused: 'series.ReleasesPaused',
  ReleasesResumed: 'series.ReleasesResumed',
  PauseEnded: 'series.PauseEnded',
};

/**
 * Fields a notice adds beside the event payload, for routing and rendering:
 * - `bid.delivered` goes to the bidder's own account: `wallet` is the event's `bidder`;
 * - `auction.mint-finalized` names the raise's outcome: a settled raise sells at least one unit and a failed one
 *   finalizes its mint with (0, 0) (S2 D7), so `unitsSold` tells them apart.
 */
function routing(e: DomainEvent): Record<string, unknown> {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'BidDelivered' && typeof p.bidder === 'string') return { wallet: p.bidder };
  if (e.type === 'RaiseMintFinalized') return { outcome: BigInt(String(p.unitsSold ?? '0')) > 0n ? 'settled' : 'failed' };
  return {};
}

export async function enqueueChainNotice(client: PoolClient, e: DomainEvent): Promise<void> {
  const kind = CHAIN_NOTICES[e.type];
  if (!kind) return;
  const seriesId = (e.payload as { seriesId?: string }).seriesId;
  await enqueueOutbox(client, 'notification', { kind, seriesId, chain: e.chain, seq: e.seq, txId: e.txId, ...routing(e), payload: e.payload });
}

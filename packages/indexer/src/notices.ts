import type { PoolClient } from '@merces/db';
import { enqueueOutbox } from '@merces/core';
import type { DomainEvent } from '@merces/domain';

/**
 * Chain events that notify people (E12). They are enqueued here, in the same transaction that projects the event
 * and advances the cursor, so a crash can neither lose a notice nor send it twice; whoever caused the event (a
 * keeper crank, a user's transaction) does not matter. The payload carries the event's chain and sequence, so two
 * identical transitions at different times are two notices, while a redelivered outbox row still dedupes.
 * Payloads hold statuses, ids and dates only; the notifications module whitelists what it stores (safeData).
 */
const CHAIN_NOTICES: Record<string, string> = {
  AuctionSettled: 'auction.settled',
  AuctionFailed: 'auction.failed',
  StatusChanged: 'series.StatusChanged',
  FormalNoticeDue: 'series.FormalNoticeDue',
  ReleasesPaused: 'series.ReleasesPaused',
  ReleasesResumed: 'series.ReleasesResumed',
  PauseEnded: 'series.PauseEnded',
};

export async function enqueueChainNotice(client: PoolClient, e: DomainEvent): Promise<void> {
  const kind = CHAIN_NOTICES[e.type];
  if (!kind) return;
  const seriesId = (e.payload as { seriesId?: string }).seriesId;
  await enqueueOutbox(client, 'notification', { kind, seriesId, chain: e.chain, seq: e.seq, txId: e.txId, payload: e.payload });
}

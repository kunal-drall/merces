import { ChainError, nextSettlementStep, type Command, type EventPayload, type EventType, type PermissionlessCommand } from '@merces/domain';
import { personalityLimits } from '../addresses.ts';
import { settlementViewOf } from '../reads/auction.ts';
import { str, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { beginSettlement, deliverBody, finalizeSettlement, processBid, tallyBids } from './settlement.ts';

/**
 * The one-step `settleAuction` and the pull `claimRefund`, kept as composites over Stage 1's settlement steps so that
 * their callers keep working until they move to the steps themselves (S2 amendment L1: WP4b migrates them, WP8 deletes
 * these). Both run inside one transaction, so either everything applies or nothing does. They keep the surface those
 * callers pin: `AuctionSettled.totalFees` and the `BidRefunded` event.
 */

/** A bound on the steps one composite settlement may take (begin, tally pages, finalize, one process per bid). */
const MAX_COMPOSITE_STEPS = 100_000;

function runStep(e: EngineCore, cmd: PermissionlessCommand, now: number, emit: Emit): void {
  switch (cmd.kind) {
    case 'beginSettlement': return beginSettlement(e, cmd, now, emit);
    case 'tallyBids': return tallyBids(e, cmd, emit);
    case 'finalizeSettlement': return finalizeSettlement(e, cmd, now, emit);
    case 'processBid': return processBid(e, cmd, emit);
    default: throw new ChainError('ChainSpecific', `settleAuction does not run ${cmd.kind}`); // never planned: deliver is false
  }
}

/**
 * @deprecated the one-step settlement, as a composite (S2 WP4b moves its callers to the steps; WP8 removes it): from
 * the planner's honest proposal, `beginSettlement`, every `tallyBids` page, `finalizeSettlement` and a `processBid` for
 * every bid, in one transaction. Refunds stay pending until delivered (`claimRefund`, `deliverBid`). Refused with
 * SettlementNotReady (code TooEarly) before the reveal end, RaiseNotOpen when there is nothing to settle. The
 * `AuctionSettled` it emits carries the deprecated `totalFees` (Σ the fees of the bids it processed).
 */
export function settleAuction(e: EngineCore, cmd: Extract<Command, { kind: 'settleAuction' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const limits = personalityLimits(e.state.config.personality);
  // the AuctionSettled payload is completed with the fees once every bid is processed (same transaction)
  const legacy: { settled: EventPayload<'AuctionSettled'> | null; fees: bigint } = { settled: null, fees: 0n };
  const tap: Emit = <T extends EventType>(type: T, payload: EventPayload<T>): void => {
    if (type === 'AuctionSettled') legacy.settled = payload as EventPayload<'AuctionSettled'>;
    if (type === 'UnitsAllocated') legacy.fees += BigInt((payload as EventPayload<'UnitsAllocated'>).fee);
    emit(type, payload);
  };
  let ran = 0;
  for (;;) {
    const step = nextSettlementStep(settlementViewOf(s, now), { now, limits, deliver: false });
    if (step.kind === 'wait') fail('SettlementNotReady', 'the reveal phase has not ended');
    if (step.kind === 'stuck') throw new ChainError('ChainSpecific', `settlement cannot proceed (${step.reason})`, { reason: step.reason });
    if (step.kind === 'done') break;
    if (++ran > MAX_COMPOSITE_STEPS) throw new ChainError('ChainSpecific', 'settlement did not finish');
    runStep(e, step.command, now, tap);
  }
  if (ran === 0) fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (legacy.settled) legacy.settled.totalFees = str(legacy.fees);
}

/**
 * @deprecated the pull refund, as a composite (S2 WP4b moves its callers to `deliverBid`; WP8 removes it): delivers the
 * signer's processed bid (`deliverBid`'s effects: its refund and its units) under the legacy event
 * `BidRefunded{amount}`. Refused as before: no bid (NotFound), not processed yet (TooEarly), nothing left to refund
 * (NotFound).
 */
export function claimRefund(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimRefund' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const b = s.bids.get(signer);
  if (!b) throw new ChainError('NotFound', 'no bid');
  if (!b.processed) throw new ChainError('TooEarly', 'auction not settled');
  if (b.delivered || b.pendingRefund === 0n) throw new ChainError('NotFound', 'nothing to refund');
  const amount = b.pendingRefund;
  deliverBody(e, s, b, () => undefined); // the legacy event replaces BidDelivered
  emit('BidRefunded', { seriesId: s.seriesId, bidder: signer, amount: str(amount) });
}

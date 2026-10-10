export * from './jobs.ts';
export * from './curve.ts';
export * from './rate-keeper.ts';
export * from './scheduler.ts';
import { auctionDeliverJob, auctionSettleJob, burnCrankJob, deadlineRemindersJob, fxCoverageJob, outboxJob, pauseCrankJob, revealRemindersJob, statusCrankJob, transferWindowsJob, type KeeperJob } from './jobs.ts';
import { curveLifecycleJob, curveStakeRemindersJob, curveSyncJob, curveTenderRemindersJob } from './curve.ts';
import { rateKeeperJob, type RateKeeperOptions } from './rate-keeper.ts';
import type { OutboxHandler } from '@merces/core';

/**
 * The standard job set, in the order they run. A curve's lifecycle runs before its census (a census right after the
 * completion lets holders stake), and both before the reminders that read them.
 */
export function standardJobs(opts: RateKeeperOptions & { outbox: OutboxHandler }): KeeperJob[] {
  return [
    auctionSettleJob, auctionDeliverJob, curveLifecycleJob, curveSyncJob, revealRemindersJob, statusCrankJob, pauseCrankJob, burnCrankJob, deadlineRemindersJob,
    curveStakeRemindersJob, curveTenderRemindersJob, rateKeeperJob(opts), fxCoverageJob, transferWindowsJob, outboxJob(opts.outbox),
  ];
}

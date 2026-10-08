export * from './jobs.ts';
export * from './rate-keeper.ts';
export * from './scheduler.ts';
import { auctionSettleJob, burnCrankJob, deadlineRemindersJob, fxCoverageJob, outboxJob, pauseCrankJob, revealRemindersJob, statusCrankJob, transferWindowsJob, type KeeperJob } from './jobs.ts';
import { rateKeeperJob, type RateKeeperOptions } from './rate-keeper.ts';
import type { OutboxHandler } from '@merces/core';

/** The standard job set, in the order they run. */
export function standardJobs(opts: RateKeeperOptions & { outbox: OutboxHandler }): KeeperJob[] {
  return [auctionSettleJob, revealRemindersJob, statusCrankJob, pauseCrankJob, burnCrankJob, deadlineRemindersJob, rateKeeperJob(opts), fxCoverageJob, transferWindowsJob, outboxJob(opts.outbox)];
}

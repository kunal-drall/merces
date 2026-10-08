import { dispatchOutbox, enqueueOutbox, getFlag } from '@merces/core';
import { withTransaction } from '@merces/db';
import { ChainError, type ChainErrorCode, type ChainPort } from '@merces/domain';
import { parsePeriod, periodOf, periodsBetween } from '@merces/math';
import { AuctionService, type ServiceContext } from '@merces/services';
import type { OutboxHandler } from '@merces/core';

/**
 * Keeper jobs (E7). Each takes the service context and returns the number of actions. They use only the
 * permissionless `submit` path with the keeper role (a low-privilege fee-payer key on live chains) and never a
 * user's funds. Running a job twice or late is harmless: the chain refuses a repeated crank and reminders are
 * recorded once.
 *
 * Failure handling: chains and series are independent, so one chain's outage or one series' error never stops
 * the others. Only the chain's expected "nothing to do" refusals (a ChainError with a known code) are swallowed;
 * every other error is collected and returned in `errors`, which the scheduler records as a failed run
 * (keeper_runs.ok = false) so a stuck series raises an alert. Chain-event notices (status changes, pause end,
 * auction settled) are enqueued by the indexer from the finalized events, not from submit results here.
 */
export interface KeeperJob {
  name: string;
  /** seconds between runs in the scheduler loop */
  intervalSeconds: number;
  run(ctx: ServiceContext): Promise<KeeperResult>;
}

export interface KeeperResult {
  actions: number;
  detail?: string;
  /** unexpected failures (chain, series and message); non-empty marks the run as failed */
  errors?: string[];
}

const message = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/** A refusal the chain gives when there is simply nothing to do. Anything else is a failure worth an alert. */
export function refused(e: unknown, codes: ChainErrorCode[]): boolean {
  return e instanceof ChainError && codes.includes(e.code);
}

async function forEachChain(ctx: ServiceContext, errors: string[], fn: (chain: ChainPort) => Promise<void>): Promise<void> {
  for (const chain of ctx.chains.chains.values()) {
    try {
      await fn(chain);
    } catch (e) {
      errors.push(`${chain.chain}: ${message(e)}`);
    }
  }
}

async function forEachSettled(ctx: ServiceContext, errors: string[], fn: (chain: ChainPort, s: Awaited<ReturnType<ChainPort['listSeries']>>[number], now: number) => Promise<void>): Promise<void> {
  await forEachChain(ctx, errors, async (chain) => {
    const now = await chain.now();
    for (const s of await chain.listSeries()) {
      if (s.phase !== 'Settled') continue;
      try {
        await fn(chain, s, now);
      } catch (e) {
        errors.push(`${s.seriesId}: ${message(e)}`);
      }
    }
  });
}

export const auctionSettleJob: KeeperJob = {
  name: 'auction.settle',
  intervalSeconds: 60,
  async run(ctx) {
    const r = await new AuctionService(ctx).settleDue();
    return { actions: r.settled.length, errors: r.failed };
  },
};

export const revealRemindersJob: KeeperJob = {
  name: 'auction.reveal-reminders',
  intervalSeconds: 600,
  async run(ctx) {
    const errors: string[] = [];
    const actions = await new AuctionService(ctx).revealReminders(12, errors);
    return { actions, errors };
  },
};

/** crankStatus on every live series whose standing may have changed; the chain emits StatusChanged / FormalNoticeDue. */
export const statusCrankJob: KeeperJob = {
  name: 'status.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      try {
        const r = await chain.submit({ kind: 'crankStatus', seriesId: s.seriesId }, 'keeper');
        if (r.events.length) actions++;
      } catch (e) {
        if (!refused(e, ['WrongPhase', 'WrongStatus', 'TooEarly'])) throw e;
      }
    });
    return { actions, errors };
  },
};

/** Ends approved pauses whose end date passed. */
export const pauseCrankJob: KeeperJob = {
  name: 'pause.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (s.status !== 'Paused' || !s.pause?.approvedUntil || now < s.pause.approvedUntil) return;
      try {
        await chain.submit({ kind: 'crankPause', seriesId: s.seriesId }, 'keeper');
        actions++;
      } catch (e) {
        if (!refused(e, ['WrongStatus', 'TooEarly'])) throw e;
      }
    });
    return { actions, errors };
  },
};

/** Burns units of Retired/Extinguished series whose holders have not claimed (holders keep their claimable payouts). */
export const burnCrankJob: KeeperJob = {
  name: 'burn.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s) => {
      if (s.status !== 'Retired' && s.status !== 'Extinguished') return;
      const holders = (await chain.listPositions(s.seriesId)).filter((p) => BigInt(p.units) > 0n).map((p) => p.wallet);
      if (!holders.length) return;
      try {
        await chain.submit({ kind: 'crankBurn', seriesId: s.seriesId, holders }, 'keeper');
        actions += holders.length;
      } catch (e) {
        if (!refused(e, ['WrongStatus', 'NotFound'])) throw e;
      }
    });
    return { actions, errors };
  },
};

/** Report-deadline reminders (C8): 7 days before due, at due, at grace end. Recorded once per milestone. */
export const deadlineRemindersJob: KeeperJob = {
  name: 'reporting.reminders',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      for (const p of await chain.listPeriods(s.seriesId)) {
        if (p.settled) continue;
        const milestones: [string, number][] = [['report-due-soon', p.dueAt - 7 * 86_400], ['report-due', p.dueAt], ['grace-end', p.graceEndsAt]];
        for (const [kind, at] of milestones) {
          if (now < at) continue;
          // the ledger row and the notice commit together: a crash between them can neither lose nor repeat it
          const fresh = await withTransaction(ctx.pool, async (db) => {
            const ins = await db.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', [kind, `${s.seriesId}:${p.periodId}`, s.issuer]);
            if (!ins.rowCount) return false;
            await enqueueOutbox(db, 'notification', { kind: `reporting.${kind}`, seriesId: s.seriesId, periodId: p.periodId, wallet: s.issuer, dueAt: p.dueAt, graceEndsAt: p.graceEndsAt });
            return true;
          });
          if (fresh) actions++;
        }
      }
    });
    return { actions, errors };
  },
};

/** Quarterly transfer windows (R19): built, switched off by the `transfer_windows` flag. Opens a window after lockup once per quarter and clears it when due. */
export const transferWindowsJob: KeeperJob = {
  name: 'transfer.windows',
  intervalSeconds: 3600,
  async run(ctx) {
    if (!(await getFlag(ctx.pool, 'transfer_windows'))) return { actions: 0, detail: 'flag off' };
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished'].includes(s.status) || s.lockupEndsAt === null || now < s.lockupEndsAt) return;
      const w = await chain.getTransferWindow(s.seriesId);
      if (w && !w.cleared) {
        if (now >= w.revealEndsAt) {
          try {
            await chain.submit({ kind: 'clearTransferWindow', seriesId: s.seriesId, windowId: w.windowId }, 'keeper');
            actions++;
          } catch (e) {
            if (!refused(e, ['Duplicate', 'TooEarly'])) throw e;
          }
        }
        return;
      }
      // one window per quarter, opening 14 days after quarter start
      const q = periodOf(now);
      if (now < q.start + 14 * 86_400) return;
      const lastQuarter = w ? periodOf(w.commitEndsAt).id : null;
      if (lastQuarter === q.id) return;
      try {
        await chain.submit({ kind: 'openTransferWindow', seriesId: s.seriesId, commitEndsAt: now + 7 * 86_400, revealEndsAt: now + 9 * 86_400 }, 'keeper');
        actions++;
      } catch (e) {
        if (!refused(e, ['Duplicate', 'TooEarly', 'WrongStatus'])) throw e;
      }
    });
    return { actions, errors };
  },
};

/** Flags quarters whose rate coverage failed (C9) and opens an attestor fallback request. Runs after each quarter end. */
export const fxCoverageJob: KeeperJob = {
  name: 'fx.coverage',
  intervalSeconds: 6 * 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachChain(ctx, errors, async (chain) => {
      const now = await chain.now();
      const pairs = await ctx.pool.query<{ pair: string }>('select pair from rate_pairs where chain = $1 and enabled', [chain.chain]);
      const currencies = new Set<string>();
      for (const s of await chain.listSeries()) if (s.terms.reportingCurrency !== 'USD') currencies.add(`${s.terms.reportingCurrency}/USD`);
      for (const p of pairs.rows) currencies.add(p.pair);
      for (const pair of currencies) {
        // check the last 4 completed quarters
        for (const per of periodsBetween(now - 400 * 86_400, now).filter((x) => x.end <= now).slice(-4)) {
          const q = await chain.getQuarterRate(pair, per.id);
          if (!q || !q.needsFallback || q.fallbackReason === 'deviation') {
            if (q && q.needsFallback) await openFallback(ctx, chain.chain, pair, per.id, 'deviation');
            continue;
          }
          const flagged = await ctx.pool.query('select 1 from fx_fallbacks where chain = $1 and pair = $2 and period_id = $3', [chain.chain, pair, per.id]);
          if (!flagged.rowCount) {
            try {
              await chain.submit({ kind: 'flagFxFallback', pair, periodId: per.id, reason: 'coverage' }, 'keeper');
              actions++;
            } catch (e) {
              if (!refused(e, ['Duplicate', 'TooEarly', 'InvalidTerms'])) throw e;
            }
          }
          if (await openFallback(ctx, chain.chain, pair, per.id, 'coverage')) actions++;
        }
      }
    });
    return { actions, errors };
  },
};

/** The fallback request and its notice commit together (a crash between them would otherwise lose the notice). */
export async function openFallback(ctx: ServiceContext, chain: string, pair: string, periodId: string, reason: string): Promise<boolean> {
  return withTransaction(ctx.pool, async (db) => {
    const r = await db.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5) on conflict (chain, pair, period_id) do nothing', [ctx.newId('fxreq'), chain, pair, periodId, reason]);
    if (r.rowCount) await enqueueOutbox(db, 'notification', { kind: 'fx.fallback-needed', chain, pair, periodId, reason });
    return !!r.rowCount;
  });
}

export function outboxJob(handler: OutboxHandler): KeeperJob {
  return {
    name: 'outbox.dispatch',
    intervalSeconds: 15,
    async run(ctx) {
      const client = await ctx.pool.connect();
      try {
        const r = await dispatchOutbox(client, handler);
        return { actions: r.dispatched, detail: r.failed ? `${r.failed} failed` : undefined };
      } finally {
        client.release();
      }
    },
  };
}

export { parsePeriod };

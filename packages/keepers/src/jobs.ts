import { dispatchOutbox, enqueueOutbox, getFlag } from '@merces/core';
import type { ChainPort } from '@merces/domain';
import { parsePeriod, periodOf, periodsBetween } from '@merces/math';
import { AuctionService, type ServiceContext } from '@merces/services';
import type { OutboxHandler } from '@merces/core';

/**
 * Keeper jobs (E7). Each takes the service context and returns the number of actions. They use only the
 * permissionless `submit` path with the keeper role (a low-privilege fee-payer key on live chains) and never a
 * user's funds. Running a job twice or late is harmless: the chain refuses a repeated crank and reminders are
 * recorded once.
 */
export interface KeeperJob {
  name: string;
  /** seconds between runs in the scheduler loop */
  intervalSeconds: number;
  run(ctx: ServiceContext): Promise<{ actions: number; detail?: string }>;
}

async function forEachSettled(ctx: ServiceContext, fn: (chain: ChainPort, s: Awaited<ReturnType<ChainPort['listSeries']>>[number], now: number) => Promise<void>): Promise<void> {
  for (const chain of ctx.chains.chains.values()) {
    const now = await chain.now();
    for (const s of await chain.listSeries()) if (s.phase === 'Settled') await fn(chain, s, now);
  }
}

export const auctionSettleJob: KeeperJob = {
  name: 'auction.settle',
  intervalSeconds: 60,
  async run(ctx) {
    const r = await new AuctionService(ctx).settleDue();
    return { actions: r.settled.length, detail: r.failed.length ? `failed: ${r.failed.join('; ')}` : undefined };
  },
};

export const revealRemindersJob: KeeperJob = {
  name: 'auction.reveal-reminders',
  intervalSeconds: 600,
  async run(ctx) {
    return { actions: await new AuctionService(ctx).revealReminders() };
  },
};

/** crankStatus on every live series whose standing may have changed; the chain emits StatusChanged / FormalNoticeDue. */
export const statusCrankJob: KeeperJob = {
  name: 'status.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    await forEachSettled(ctx, async (chain, s) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      try {
        const r = await chain.submit({ kind: 'crankStatus', seriesId: s.seriesId }, 'keeper');
        if (r.events.length) {
          actions++;
          for (const e of r.events) await enqueueOutbox(ctx.pool, 'notification', { kind: `series.${e.type}`, seriesId: s.seriesId, payload: e.payload });
        }
      } catch {
        /* not crankable yet */
      }
    });
    return { actions };
  },
};

/** Ends approved pauses whose end date passed. */
export const pauseCrankJob: KeeperJob = {
  name: 'pause.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    await forEachSettled(ctx, async (chain, s, now) => {
      if (s.status !== 'Paused' || !s.pause?.approvedUntil || now < s.pause.approvedUntil) return;
      try {
        await chain.submit({ kind: 'crankPause', seriesId: s.seriesId }, 'keeper');
        actions++;
        await enqueueOutbox(ctx.pool, 'notification', { kind: 'series.PauseEnded', seriesId: s.seriesId });
      } catch {
        /* already ended */
      }
    });
    return { actions };
  },
};

/** Burns units of Retired/Extinguished series whose holders have not claimed (holders keep their claimable payouts). */
export const burnCrankJob: KeeperJob = {
  name: 'burn.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    await forEachSettled(ctx, async (chain, s) => {
      if (s.status !== 'Retired' && s.status !== 'Extinguished') return;
      const holders = (await chain.listPositions(s.seriesId)).filter((p) => BigInt(p.units) > 0n).map((p) => p.wallet);
      if (!holders.length) return;
      try {
        await chain.submit({ kind: 'crankBurn', seriesId: s.seriesId, holders }, 'keeper');
        actions += holders.length;
      } catch {
        /* nothing to burn */
      }
    });
    return { actions };
  },
};

/** Report-deadline reminders (C8): 7 days before due, at due, at grace end. Recorded once per milestone. */
export const deadlineRemindersJob: KeeperJob = {
  name: 'reporting.reminders',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    await forEachSettled(ctx, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      for (const p of await chain.listPeriods(s.seriesId)) {
        if (p.settled) continue;
        const milestones: [string, number][] = [['report-due-soon', p.dueAt - 7 * 86_400], ['report-due', p.dueAt], ['grace-end', p.graceEndsAt]];
        for (const [kind, at] of milestones) {
          if (now < at) continue;
          const ins = await ctx.pool.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', [kind, `${s.seriesId}:${p.periodId}`, s.issuer]);
          if (ins.rowCount) {
            await enqueueOutbox(ctx.pool, 'notification', { kind: `reporting.${kind}`, seriesId: s.seriesId, periodId: p.periodId, wallet: s.issuer, dueAt: p.dueAt, graceEndsAt: p.graceEndsAt });
            actions++;
          }
        }
      }
    });
    return { actions };
  },
};

/** Quarterly transfer windows (R19): built, switched off by the `transfer_windows` flag. Opens a window after lockup once per quarter and clears it when due. */
export const transferWindowsJob: KeeperJob = {
  name: 'transfer.windows',
  intervalSeconds: 3600,
  async run(ctx) {
    if (!(await getFlag(ctx.pool, 'transfer_windows'))) return { actions: 0, detail: 'flag off' };
    let actions = 0;
    await forEachSettled(ctx, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished'].includes(s.status) || s.lockupEndsAt === null || now < s.lockupEndsAt) return;
      const w = await chain.getTransferWindow(s.seriesId);
      if (w && !w.cleared) {
        if (now >= w.revealEndsAt) {
          await chain.submit({ kind: 'clearTransferWindow', seriesId: s.seriesId, windowId: w.windowId }, 'keeper').catch(() => undefined);
          actions++;
        }
        return;
      }
      // one window per quarter, opening 14 days after quarter start
      const q = periodOf(now);
      if (now < q.start + 14 * 86_400) return;
      const lastQuarter = w ? periodOf(w.commitEndsAt).id : null;
      if (lastQuarter === q.id) return;
      await chain.submit({ kind: 'openTransferWindow', seriesId: s.seriesId, commitEndsAt: now + 7 * 86_400, revealEndsAt: now + 9 * 86_400 }, 'keeper').catch(() => undefined);
      actions++;
    });
    return { actions };
  },
};

/** Flags quarters whose rate coverage failed (C9) and opens an attestor fallback request. Runs after each quarter end. */
export const fxCoverageJob: KeeperJob = {
  name: 'fx.coverage',
  intervalSeconds: 6 * 3600,
  async run(ctx) {
    let actions = 0;
    for (const chain of ctx.chains.chains.values()) {
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
            } catch {
              /* already flagged onchain */
            }
          }
          if (await openFallback(ctx, chain.chain, pair, per.id, 'coverage')) actions++;
        }
      }
    }
    return { actions };
  },
};

async function openFallback(ctx: ServiceContext, chain: string, pair: string, periodId: string, reason: string): Promise<boolean> {
  const r = await ctx.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5) on conflict (chain, pair, period_id) do nothing', [ctx.newId('fxreq'), chain, pair, periodId, reason]);
  if (r.rowCount) await enqueueOutbox(ctx.pool, 'notification', { kind: 'fx.fallback-needed', chain, pair, periodId, reason });
  return !!r.rowCount;
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

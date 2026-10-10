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
 * (keeper_runs.ok = false) so a stuck series raises an alert. The auction jobs report codes only, never a message
 * (S2 L7: adapter messages can embed values). Chain-event notices (status changes, pause end, auction settled or failed,
 * mint finalized, bid delivered) are enqueued by the indexer from the finalized events, not from submit results here.
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

type Series = Awaited<ReturnType<ChainPort['listSeries']>>[number];

/**
 * Every settled series on every chain. With `requireMintFinalized`, only those whose last bid is processed (Stage 1's
 * `mintFinalized`): the money paths and windows refuse a series before that (MintNotFinalized).
 */
async function forEachSettled(ctx: ServiceContext, errors: string[], fn: (chain: ChainPort, s: Series, now: number) => Promise<void>, opts: { requireMintFinalized?: boolean } = {}): Promise<void> {
  await forEachChain(ctx, errors, async (chain) => {
    const now = await chain.now();
    for (const s of await chain.listSeries()) {
      if (s.phase !== 'Settled') continue;
      if (opts.requireMintFinalized && !s.mintFinalized) continue;
      try {
        await fn(chain, s, now);
      } catch (e) {
        errors.push(`${s.seriesId}: ${message(e)}`);
      }
    }
  });
}

/**
 * Stage 1's sealed-bid settlement, one pass per run (`AuctionService.advanceSettlements` with `deliver: false`): the
 * proposal, the tally pages, finalize and a `processBid` per bid. Delivery is `auction.deliver`'s. Actions are the steps
 * sent; a series the planner will not act on (also told to the admins once, `auction.settlement-stuck`), or whose pass
 * raised, is an error (value-free: the series and a Stage 1 error name, ChainError code or stuck reason, never a
 * message; S2 L7).
 */
export const auctionSettleJob: KeeperJob = {
  name: 'auction.settle',
  intervalSeconds: 60,
  async run(ctx) {
    const r = await new AuctionService(ctx).advanceSettlements({ deliver: false });
    const errors = [...r.failed.map((f) => `${f.target}: ${f.error}`), ...r.stuck.map((x) => `${x.seriesId}: stuck (${x.reason})`)];
    return { actions: r.advanced.reduce((n, a) => n + a.steps.length, 0), errors };
  },
};

/**
 * Pushes every processed, undelivered bid (`AuctionService.deliverDue`: Stage 1 `deliver_bid` pays the refund and the
 * units), each with its own backoff after a refusal (1 min, 5 min, 30 min, 2 h, 12 h, then daily); a bid still failing 24 h
 * after its raise was finalized is told once to the admins and the bidder (`bid.delivery-stuck`). Actions are the bids
 * delivered; a refused delivery or an unreadable chain or series is an error (value-free: the series, the bidder and a
 * Stage 1 error name or ChainError code, never a message; S2 L7). Bids waiting out their backoff are counted in the
 * detail, not as errors.
 */
export const auctionDeliverJob: KeeperJob = {
  name: 'auction.deliver',
  intervalSeconds: 60,
  async run(ctx) {
    const r = await new AuctionService(ctx).deliverDue();
    const errors = [...r.failed.map((f) => `${f.seriesId} ${f.bidder}: ${f.error} (attempt ${f.attempts})`), ...r.errors.map((x) => `${x.target}: ${x.error}`)];
    const detail = [r.deferred ? `${r.deferred} waiting` : null, r.stuck.length ? `${r.stuck.length} reported stuck` : null].filter(Boolean).join(', ') || undefined;
    return { actions: r.delivered.length, errors, detail };
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

/**
 * The only period Stage 1's `deriveStatus` counts from (`earliestUnpaid`): `openDuePeriod` while a due is open (its
 * report is in, its payment is outstanding), else the next expected period (its report is outstanding). Every later
 * period waits on it: Stage 1 refuses their reports (WrongPeriod / PaymentOutstanding) and their countdowns move no
 * status until it is paid. Null before settlement.
 */
export function earliestUnpaidPeriod(s: Series): { periodId: string; outstanding: 'report' | 'payment' } | null {
  const rep = s.reporting;
  if (BigInt(rep.openDueAmount) > 0n && rep.openDuePeriod !== null) return { periodId: rep.openDuePeriod, outstanding: 'payment' };
  return rep.nextExpectedPeriod === null ? null : { periodId: rep.nextExpectedPeriod, outstanding: 'report' };
}

/**
 * The status milestones of a series that time alone moves (Stage 1 `deriveStatus` on the earliest unpaid period,
 * `earliestUnpaidPeriod`): InGrace at the first instant after `dueAt` (countdown > 30 days), Late at the first instant
 * after `graceEndsAt` (> 45 days) and the formal notice at `formalNoticeAt` (≥ 90 days). The instants are the chain's
 * period read (`projectDeadlines`, counted in unpaused time from the period end); only those already reached are
 * returned.
 */
export async function reachedMilestones(chain: ChainPort, s: Series, now: number): Promise<{ periodId: string; milestones: ('InGrace' | 'Late' | 'FormalNotice')[] } | null> {
  const periodId = earliestUnpaidPeriod(s)?.periodId ?? null;
  if (periodId === null) return null;
  const p = await chain.getPeriod(s.seriesId, periodId);
  if (!p) return null;
  const milestones: ('InGrace' | 'Late' | 'FormalNotice')[] = [];
  if (now > p.dueAt) milestones.push('InGrace');
  if (now > p.graceEndsAt) milestones.push('Late');
  if (now >= p.formalNoticeAt) milestones.push('FormalNotice');
  return { periodId, milestones };
}

/**
 * crankStatus (Stage 1 `crank_status`) when a status milestone of the earliest unpaid period has been reached and the
 * chain has not recorded it yet: the formal notice when `formalNoticeEmittedFor` is another period; InGrace / Late when
 * the indexed status (the status the chain last stored, from its StatusChanged events) differs from the status derived
 * now. A series the indexer has not projected yet is cranked whenever a milestone is reached (a crank with nothing to
 * record emits nothing). Paused series are left to the pause crank, terminal ones are never cranked. The chain emits
 * StatusChanged / FormalNoticeDue and the release-block events.
 */
export const statusCrankJob: KeeperJob = {
  name: 'status.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      const reached = await reachedMilestones(chain, s, now);
      if (!reached || reached.milestones.length === 0) return;
      const noticePending = reached.milestones.includes('FormalNotice') && s.formalNoticeEmittedFor !== reached.periodId;
      if (!noticePending) {
        const indexed = await ctx.pool.query<{ status: string }>('select status from series where series_id = $1', [s.seriesId]);
        if (indexed.rows[0] && indexed.rows[0].status === s.status) return;
      }
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

/**
 * Announces hardship pauses whose end passed (`PauseEnded`). Events only: a pause ends by itself at its approved end
 * (Stage 1), so the series is no longer Paused by then; `pause.approvedUntil` is the oldest pause not yet announced.
 */
export const pauseCrankJob: KeeperJob = {
  name: 'pause.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (!s.pause?.approvedUntil || now < s.pause.approvedUntil) return;
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

/**
 * Burns units of Retired series whose holders have not claimed (holders keep their claimable payouts). An Extinguished
 * series is never cranked: Stage 1 refuses it (`burn_retired` TerminalStatus), since the holder's units are its weight
 * in the final pool until it claims.
 */
export const burnCrankJob: KeeperJob = {
  name: 'burn.crank',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s) => {
      if (s.status !== 'Retired') return;
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

/**
 * Report-deadline reminders (C8), for the earliest unpaid period only (`earliestUnpaidPeriod`, the period Stage 1's
 * `deriveStatus` counts from, as `reachedMilestones`): a later period is never reminded while an earlier one holds the
 * status, since the chain cannot take its report yet and its own countdown moves nothing; it is reminded once it
 * becomes the earliest unpaid period. The instants are the chain's (`projectDeadlines`, Stage 1's inclusive bounds):
 * 7 days before `dueAt` (the last OnTime instant), the first instant after `dueAt` (more than 30 days of unpaused time
 * since the period end) and the first instant after `graceEndsAt` (more than 45 days). The notice carries what is
 * outstanding (the report, or the payment of a reported period) and the series' status as the chain derives it when
 * the notice is queued (Stage 1 `deriveStatus`, which an overdue true-up also makes Late), never a status assumed from
 * the milestone. Recorded once per milestone and period.
 */
export const deadlineRemindersJob: KeeperJob = {
  name: 'reporting.reminders',
  intervalSeconds: 3600,
  async run(ctx) {
    let actions = 0;
    const errors: string[] = [];
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) return;
      const due = earliestUnpaidPeriod(s);
      if (!due) return;
      const p = await chain.getPeriod(s.seriesId, due.periodId);
      if (!p || p.settled) return;
      const milestones: [string, number][] = [['report-due-soon', p.dueAt - 7 * 86_400], ['report-due', p.dueAt + 1], ['grace-end', p.graceEndsAt + 1]];
      for (const [kind, at] of milestones) {
        if (now < at) continue;
        // the ledger row and the notice commit together: a crash between them can neither lose nor repeat it
        const fresh = await withTransaction(ctx.pool, async (db) => {
          const ins = await db.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', [kind, `${s.seriesId}:${p.periodId}`, s.issuer]);
          if (!ins.rowCount) return false;
          await enqueueOutbox(db, 'notification', { kind: `reporting.${kind}`, seriesId: s.seriesId, periodId: p.periodId, wallet: s.issuer, dueAt: p.dueAt, graceEndsAt: p.graceEndsAt, outstanding: due.outstanding, status: s.status });
          return true;
        });
        if (fresh) actions++;
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
    const flagOn = await getFlag(ctx.pool, 'transfer_windows');
    let actions = 0;
    const errors: string[] = [];
    // a window opens on a mint-finalized series only (Stage 1 MintNotFinalized), so one still processing its bids has no
    // window to clear either
    await forEachSettled(ctx, errors, async (chain, s, now) => {
      // An open window is always cleared once its reveal phase is over, whatever the series' status and even with the
      // flag switched off, so buy deposits and sell escrow are never left locked (A-REV-16). Only opening is gated.
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
      // curve series trade on the DEX pool after graduation, never in windows (A-CURVE-2)
      if (!flagOn || s.terms.raiseStyle === 'curve' || ['Retired', 'Redeemed', 'Extinguished'].includes(s.status) || s.lockupEndsAt === null || now < s.lockupEndsAt) return;
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
    }, { requireMintFinalized: true });
    return { actions, errors, detail: flagOn ? undefined : 'flag off: open windows are cleared, none opened' };
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

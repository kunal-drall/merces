import { enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import { ChainError, type ChainPort, type PositionState, type SeriesState } from '@merces/domain';
import { periodOf, periodOfPid } from '@merces/math';
import { advanceCurves, censusLockedBy, errorCode, type ServiceContext } from '@merces/services';
import type { KeeperJob } from './jobs.ts';

/**
 * The curve keepers (S3 WP11; curve mode is Solana only). They send Stage 1's permissionless curve commands with the
 * keeper's own fee payer and queue reminders; they never touch a holder's units or money. Errors carry codes only (a
 * Stage 1 error name, else a ChainError code, else the error's class), never a message: adapter messages can embed values.
 *
 *  - `curve.lifecycle` (1 min): completes a filled curve and collects its proceeds, then its trading fees weekly
 *    (`advanceCurves`; the admin monitor triggers the same pass).
 *  - `curve.sync` (10 min): the census (`syncCurveUnits`) once after completion, so holders can stake, then once after each
 *    period end (plus a margin) unless a census already postdates it, so the issuer can report (Stage 1's report gate,
 *    CurveUnitsNotSynced). Never on a terminal series, and never while the issuer has assembled the report for the next
 *    expected period and not submitted it: its proof binds the census (amendment H1).
 *  - `curve.stake-reminders` (daily): the account of every linked wallet holding units of a settled, non-terminal curve in
 *    its wallet (they earn nothing unstaked), once per payment round and next step.
 *  - `curve.tender-reminders` (1 h): once a curve redeemed, the account of every linked wallet holding units in its
 *    wallet while the tender quota lasts (wallet units share it; staked units are reserved), once per next step.
 */

type Series = SeriesState;

/** Statuses after which a curve takes no census, no stake and no stake reminder (Stage 1 TerminalStatus). */
const TERMINAL = ['Retired', 'Redeemed', 'Extinguished'];

/** The margin after a period end before the keepers take its census (trades of the period's last block settle first). */
export const CURVE_SYNC_MARGIN_SECONDS = 3_600;

/** Each Solana-family chain's curve series, read once per run; a chain that cannot be read is an error (code only). */
async function forEachCurveChain(ctx: ServiceContext, errors: string[], fn: (chain: ChainPort, curves: Series[], now: number) => Promise<void>): Promise<void> {
  for (const chain of ctx.chains.chains.values()) {
    if (chain.family !== 'solana') continue;
    try {
      const now = await chain.now();
      const curves = (await chain.listSeries()).filter((s) => s.terms.raiseStyle === 'curve');
      if (curves.length) await fn(chain, curves, now);
    } catch (e) {
      errors.push(`${chain.chain}: ${errorCode(e)}`);
    }
  }
}

/** Whether the chain refused with one of Stage 1's `names` (a refusal that only means "nothing to do"). */
function refusedAs(e: unknown, names: string[]): boolean {
  return e instanceof ChainError && names.includes(String(e.detail?.stage1 ?? ''));
}

export const curveLifecycleJob: KeeperJob = {
  name: 'curve.lifecycle', requiresSigner: true,
  intervalSeconds: 60,
  async run(ctx) {
    const r = await advanceCurves(ctx);
    return { actions: r.completed.length + r.collected.length, errors: r.errors.map((x) => `${x.target}: ${x.error}`) };
  },
};

/** Why the keepers would take a census of `s` now: after its completion, or after a period end; null when none is due. */
export type CurveSyncReason = { reason: 'completion' } | { reason: 'period-end'; periodId: string; periodEnd: number };

/**
 * The census policy (Stage 1's report gate needs a census at or after a period's end; staking needs one at all):
 *  - once the curve completed (the raise is Settled) and no census was taken since its settlement time;
 *  - once the latest period that ended after the settlement has ended `CURVE_SYNC_MARGIN_SECONDS` ago, unless a census
 *    already postdates its end.
 * Never on a raise that is not Settled or on a terminal series. Pure: the H1 lock is the job's.
 */
export function curveSyncDue(s: Series, now: number): CurveSyncReason | null {
  if (s.terms.raiseStyle !== 'curve' || s.phase !== 'Settled' || s.settledAt === null || TERMINAL.includes(s.status)) return null;
  const synced = s.unitsSyncedAt;
  if (synced === null || synced < s.settledAt) return { reason: 'completion' };
  const ended = periodOfPid(periodOf(now).pid - 1);
  if (ended.end > s.settledAt && now >= ended.end + CURVE_SYNC_MARGIN_SECONDS && synced < ended.end) return { reason: 'period-end', periodId: ended.id, periodEnd: ended.end };
  return null;
}

export const curveSyncJob: KeeperJob = {
  name: 'curve.sync', requiresSigner: true,
  intervalSeconds: 600,
  async run(ctx) {
    let actions = 0;
    let held = 0;
    const errors: string[] = [];
    await forEachCurveChain(ctx, errors, async (chain, curves, now) => {
      for (const s of curves) {
        try {
          if (!curveSyncDue(s, now)) continue;
          // amendment H1: the issuer's assembled report binds the census until it is submitted
          if (await censusLockedBy(ctx, s)) {
            held++;
            continue;
          }
          await chain.submit({ kind: 'syncCurveUnits', seriesId: s.seriesId }, 'keeper');
          actions++;
        } catch (e) {
          // the series moved on since the read (it became terminal, or its raise is not open): nothing to do
          if (!refusedAs(e, ['TerminalStatus', 'RaiseNotOpen'])) errors.push(`${s.seriesId}: ${errorCode(e)}`);
        }
      }
    });
    return { actions, errors, detail: held ? `${held} held for an assembled report` : undefined };
  },
};

/** A curve wallet's next step toward staking: approval first, then registration, then the stake. */
export type CurveStakeStep = 'approve-wallet' | 'register-and-stake' | 'stake';
/** A curve wallet's next step toward a tender: a registered holder tenders (no allowlist check); otherwise it registers, which needs approval. */
export type CurveTenderStep = 'approve-wallet' | 'register-and-tender' | 'tender';

/** Stage 1's stake checks (curve.rs:1250-1313): the wallet must be allowlisted now, and a registered holder. */
export function curveStakeStep(p: PositionState, allowlisted: boolean): CurveStakeStep {
  return !allowlisted ? 'approve-wallet' : p.registered ? 'stake' : 'register-and-stake';
}

/** Stage 1's tender checks (curve.rs:1426-1528): a registered holder, with no allowlist check; registration needs one. */
export function curveTenderStep(p: PositionState, allowlisted: boolean): CurveTenderStep {
  return p.registered ? 'tender' : allowlisted ? 'register-and-tender' : 'approve-wallet';
}

/**
 * For each curve series `select` keeps, each linked wallet on its chain that holds units in its wallet: queue `kind` to
 * its account once per `target` (the series, the round and the next step), recorded in `reminders_sent` in the same
 * transaction as the notice. The wallet's units come from the chain's position read (its base balance of the unit mint;
 * listing every holder of the mint on a live chain is S5), the allowlist from the chain. Returns the reminders queued.
 */
async function remindCurveWallets(
  ctx: ServiceContext,
  errors: string[],
  kind: 'curve.stake-reminder' | 'curve.tender-reminder',
  select: (s: Series) => string | null,
  next: (p: PositionState, allowlisted: boolean) => string,
): Promise<number> {
  let actions = 0;
  await forEachCurveChain(ctx, errors, async (chain, curves) => {
    const due = curves.map((s) => ({ s, round: select(s) })).filter((x): x is { s: Series; round: string } => x.round !== null);
    if (!due.length) return;
    const wallets = (await ctx.pool.query<{ address: string }>('select address from account_wallets where chain = $1 order by address', [chain.chain])).rows.map((r) => r.address);
    const allowlisted = new Map<string, boolean>();
    for (const { s, round } of due) {
      for (const wallet of wallets) {
        try {
          const p = await chain.getPosition(s.seriesId, wallet);
          if (!p || BigInt(p.walletUnits) === 0n) continue;
          if (!allowlisted.has(wallet)) allowlisted.set(wallet, await chain.isAllowlisted(wallet));
          const step = next(p, allowlisted.get(wallet)!);
          const fresh = await withTransaction(ctx.pool, async (db) => {
            const ins = await db.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', [kind, `${s.seriesId}:${round}:${step}`, wallet]);
            if (!ins.rowCount) return false;
            await enqueueOutbox(db, 'notification', { kind, seriesId: s.seriesId, chain: chain.chain, wallet, raiseStyle: 'curve', next: step });
            return true;
          });
          if (fresh) actions++;
        } catch (e) {
          errors.push(`${s.seriesId} ${wallet}: ${errorCode(e)}`);
        }
      }
    }
  });
  return actions;
}

/**
 * Daily: a settled, non-terminal curve with a census (staking needs one: StakeExceedsOutstanding) reminds each linked
 * wallet holding unstaked units in its wallet, once per payment round (the last paid period, or the settlement before
 * the first) and next step: approve the wallet first, register and stake, or stake.
 */
export const curveStakeRemindersJob: KeeperJob = {
  name: 'curve.stake-reminders',
  intervalSeconds: 86_400,
  async run(ctx) {
    const errors: string[] = [];
    const select = (s: Series) => (s.phase === 'Settled' && !TERMINAL.includes(s.status) && s.unitsSyncedAt !== null ? (s.reporting.lastPaidPeriod ?? 'settled') : null);
    const actions = await remindCurveWallets(ctx, errors, 'curve.stake-reminder', select, curveStakeStep);
    return { actions, errors };
  },
};

/**
 * Hourly: once a curve redeemed (stored status Redeemed) and while its tender quota lasts (`units at redemption − tendered −
 * staked`: wallet units share it, staked units are reserved), each linked wallet holding units in its wallet is reminded
 * once per next step: tender, register and tender, or approve the wallet first. Holders with a position (stakers) hear
 * of the redemption from the chain notice (`curve.tender-open`).
 */
export const curveTenderRemindersJob: KeeperJob = {
  name: 'curve.tender-reminders',
  intervalSeconds: 3_600,
  async run(ctx) {
    const errors: string[] = [];
    const select = (s: Series) => {
      const r = s.redemption;
      if (!r || s.status !== 'Redeemed') return null;
      return BigInt(r.unitsAtRedemption) - BigInt(s.tenderedTotal) - BigInt(s.stakedTotal) > 0n ? 'redemption' : null;
    };
    const actions = await remindCurveWallets(ctx, errors, 'curve.tender-reminder', select, curveTenderStep);
    return { actions, errors };
  },
};

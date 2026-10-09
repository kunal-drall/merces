import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../app.ts';
import type { AppContext } from '../context.ts';
import { WAD } from '@merces/math';
import type { SeriesState } from '@merces/domain';
import { bidRefundable } from '../serialize.ts';

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext): void {
  defineRoute(app, ctx, {
    method: 'GET', url: '/me', access: 'account',
    handler: async (_req, _reply, session) => ({ accountId: session!.accountId, wallets: session!.wallets, roles: session!.roles, eligible: session!.eligible }),
  });

  /** R20: holdings with payout history and yield only; never the issuer's income sources. */
  defineRoute(app, ctx, {
    method: 'GET', url: '/me/holdings', access: 'account',
    handler: async (_req, _reply, session) => {
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query(
        `select p.series_id, p.wallet, p.units, p.claimed_total, p.redeemed_units, p.burned_units, s.chain, s.status, s.phase, s.issue_price, s.cap_per_unit, s.paid_per_unit_wad, s.stablecoin, s.lockup_ends_at, s.redemption_price
         from positions p join series s on s.series_id = p.series_id where p.wallet = any($1) order by p.first_seq`,
        [wallets],
      );
      const holdings = [];
      for (const x of r.rows) {
        const chain = ctx.chainFor(x.series_id);
        const live = await chain.getPosition(x.series_id, x.wallet);
        const unitsEver = BigInt(x.units) + BigInt(x.burned_units);
        const costBasis = x.issue_price ? BigInt(x.issue_price) * unitsEver : 0n;
        const grossPerUnit = BigInt(x.paid_per_unit_wad) / WAD;
        const yieldBps = costBasis > 0n ? (BigInt(x.claimed_total) * 10_000n) / costBasis : 0n;
        holdings.push({
          seriesId: x.series_id, chain: x.chain, wallet: x.wallet, stablecoin: x.stablecoin, phase: x.phase, status: x.status, units: x.units, redeemedUnits: x.redeemed_units, burnedUnits: x.burned_units,
          issuePrice: x.issue_price, capPerUnit: x.cap_per_unit, grossPaidPerUnit: grossPerUnit.toString(), claimedTotal: x.claimed_total, claimable: live?.claimable ?? '0', tailClaimable: live?.tailClaimable ?? '0', finalClaimable: live?.finalClaimable ?? '0',
          realisedYieldBps: Number(yieldBps), lockupEndsAt: x.lockup_ends_at === null ? null : Number(x.lockup_ends_at), redemptionPrice: x.redemption_price,
        });
      }
      return { holdings };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/me/payouts', access: 'account',
    handler: async (_req, _reply, session) => {
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query("select chain, seq, series_id, kind, amount, block_time, tx_id from money_events where wallet = any($1) and kind in ('payout','redemption_claim','refund') order by seq desc limit 500", [wallets]);
      return { payouts: r.rows.map((x) => ({ chain: x.chain, seq: Number(x.seq), seriesId: x.series_id, kind: x.kind, amount: x.amount, at: Number(x.block_time), txId: x.tx_id })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/me/bids', access: 'account',
    handler: async (_req, _reply, session) => {
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query('select b.*, s.phase, s.chain from bids b join series s on s.series_id = b.series_id where b.bidder = any($1) order by b.bid_order', [wallets]);
      const bids = [];
      const seriesCache = new Map<string, SeriesState | null>();
      for (const x of r.rows) {
        const chain = ctx.chainFor(x.series_id);
        const live = await chain.getBid(x.series_id, x.bidder);
        if (live?.settled && !seriesCache.has(x.series_id)) seriesCache.set(x.series_id, await chain.getSeries(x.series_id));
        const series = seriesCache.get(x.series_id);
        // same arithmetic as the refund builder: allocated spend and its fee are not refundable
        const refundable = !live ? null : live.settled && series ? bidRefundable(live, series).toString() : '0';
        bids.push({ seriesId: x.series_id, chain: x.chain, bidder: x.bidder, phase: x.phase, deposit: x.deposit, revealed: live?.revealed ?? null, allocatedUnits: x.allocated_units, refunded: x.refunded, refundable, settled: live?.settled ?? false });
      }
      return { bids };
    },
  });
}

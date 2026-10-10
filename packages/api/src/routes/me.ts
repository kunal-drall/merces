import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../app.ts';
import type { AppContext } from '../context.ts';
import { ChainError, perWholeUnit, type BidState, type ChainPort } from '@merces/domain';

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext): void {
  defineRoute(app, ctx, {
    method: 'GET', url: '/me', access: 'account',
    handler: async (_req, _reply, session) => ({ accountId: session!.accountId, wallets: session!.wallets, roles: session!.roles, eligible: session!.eligible }),
  });

  /**
   * R20: holdings with payout history and yield only; never the issuer's income sources. What each claim of Stage 1's
   * family pays now is read live from the chain and kept apart (S3): `claimable` (`claimPayout`, of which `pending` is
   * the part already settled into the holder's balance), `redemptionClaimable` (`claimRedemption`), `tailClaimable`
   * (`claimTail`) and `finalClaimable` (`claimFinal`).
   *
   * Every per-unit figure is per WHOLE unit at the series' unit scale (S3, amendment M4; `unitScale` on each row): a
   * curve series counts units in base lamports (10^6 to a whole unit) and its `paidPerUnitWad` is per base lamport, so
   * `grossPaidPerUnit = floor(paidPerUnitWad × unitScale / WAD)` and the cost basis is `issuePrice × units / unitScale`.
   * A curve row also carries the stake and the units in the wallet (`stakedUnits`, `walletUnits`; the curve position
   * read, `GET /series/{id}/curve/position`, covers a wallet that has not staked).
   */
  defineRoute(app, ctx, {
    method: 'GET', url: '/me/holdings', access: 'account',
    handler: async (_req, _reply, session) => {
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query(
        `select p.series_id, p.wallet, p.units, p.claimed_total, p.redeemed_units, p.burned_units, s.chain, s.status, s.phase, s.raise_style, s.unit_scale::text, s.issue_price, s.cap_per_unit, s.paid_per_unit_wad, s.stablecoin, s.lockup_ends_at, s.redemption_price
         from positions p join series s on s.series_id = p.series_id where p.wallet = any($1) order by p.first_seq`,
        [wallets],
      );
      const holdings = [];
      for (const x of r.rows) {
        const chain = ctx.chainFor(x.series_id);
        const live = await chain.getPosition(x.series_id, x.wallet);
        const unitScale = BigInt(x.unit_scale ?? '1');
        const unitsEver = BigInt(x.units) + BigInt(x.burned_units);
        const costBasis = x.issue_price ? (BigInt(x.issue_price) * unitsEver) / unitScale : 0n;
        const grossPerUnit = perWholeUnit(x.paid_per_unit_wad, unitScale);
        const yieldBps = costBasis > 0n ? (BigInt(x.claimed_total) * 10_000n) / costBasis : 0n;
        holdings.push({
          seriesId: x.series_id, chain: x.chain, wallet: x.wallet, stablecoin: x.stablecoin, phase: x.phase, status: x.status, raiseStyle: x.raise_style, unitScale: unitScale.toString(),
          units: x.units, stakedUnits: live?.stakedUnits ?? '0', walletUnits: live?.walletUnits ?? '0', redeemedUnits: x.redeemed_units, burnedUnits: x.burned_units,
          issuePrice: x.issue_price, capPerUnit: x.cap_per_unit, grossPaidPerUnit: grossPerUnit.toString(), claimedTotal: x.claimed_total, claimable: live?.claimable ?? '0', pending: live?.pending ?? '0', redemptionClaimable: live?.redemptionClaimable ?? '0', tailClaimable: live?.tailClaimable ?? '0', finalClaimable: live?.finalClaimable ?? '0',
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
      const r = await ctx.pool.query("select chain, seq, series_id, kind, amount, block_time, tx_id from money_events where wallet = any($1) and kind in ('payout','tail_claim','final_claim','redemption_claim','refund') order by seq desc limit 500", [wallets]);
      return { payouts: r.rows.map((x) => ({ chain: x.chain, seq: Number(x.seq), seriesId: x.series_id, kind: x.kind, amount: x.amount, at: Number(x.block_time), txId: x.tx_id })) };
    },
  });

  /**
   * The caller's bids (S2). Each bid's settlement fields come from one source, never a mix, so a response cannot
   * contradict itself while the indexer catches up: the chain's read of the bid (`source: 'chain'`: `revealed`,
   * `valid`, `processed`, `delivered`, `allocatedUnits` and what a processed, undelivered bid is still owed,
   * `pendingUnits` / `pendingRefund`, with `refundable` the same refund), or, when the chain has no read of the bid, the
   * indexed row as a whole (`source: 'index'`). `refunded`, the refund delivered, is carried only by the delivery
   * event (Solana zeroes the bid's pending refund at delivery), so it is indexed: "0" while the bid is undelivered,
   * then the indexed refund once the indexer has projected the delivery, and null in between (the chain shows the bid
   * delivered and the indexer has not caught up yet).
   */
  defineRoute(app, ctx, {
    method: 'GET', url: '/me/bids', access: 'account',
    handler: async (_req, _reply, session) => {
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query('select b.*, s.phase, s.chain from bids b join series s on s.series_id = b.series_id where b.bidder = any($1) order by b.bid_order', [wallets]);
      const bids = [];
      for (const x of r.rows) {
        const base = { seriesId: x.series_id, chain: x.chain, bidder: x.bidder, phase: x.phase, deposit: x.deposit };
        const live = await chainBid(ctx.chainFor(x.series_id), x.series_id, x.bidder);
        if (live) {
          // what the chain still owes the bidder (Stage 1's pending units and refund of a processed, undelivered bid; "0"
          // otherwise): the keepers deliver it, or any wallet delivers it now (S2: push delivery)
          const owed = live.processed && !live.delivered;
          bids.push({
            ...base, source: 'chain', revealed: live.revealed, valid: live.valid, processed: live.processed, delivered: live.delivered, allocatedUnits: live.allocatedUnits,
            pendingUnits: owed ? live.pendingUnits : '0', pendingRefund: owed ? live.pendingRefund : '0', refundable: owed ? live.pendingRefund : '0',
            refunded: !live.delivered ? '0' : x.delivered ? x.refunded : null,
          });
        } else {
          // the indexed row as a whole (UnitsAllocated, BidDelivered and RaiseMintFinalized keep it consistent)
          const owed = x.processed && !x.delivered;
          bids.push({
            ...base, source: 'index', revealed: x.revealed_price === null ? null : { pricePerUnit: x.revealed_price, quantity: x.revealed_quantity }, valid: x.valid ?? null,
            processed: x.processed, delivered: x.delivered, allocatedUnits: x.allocated_units,
            pendingUnits: owed ? x.pending_units : '0', pendingRefund: owed ? x.pending_refund : '0', refundable: owed ? x.pending_refund : '0',
            refunded: x.refunded,
          });
        }
      }
      return { bids };
    },
  });
}

/** The chain's read of a bid; null when the chain has no such bid or no bid read (a live adapter before S5). */
async function chainBid(chain: ChainPort, seriesId: string, bidder: string): Promise<BidState | null> {
  try {
    return await chain.getBid(seriesId, bidder);
  } catch (e) {
    if (e instanceof ChainError && e.code === 'NotImplemented') return null;
    throw e;
  }
}

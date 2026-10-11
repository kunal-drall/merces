import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@merces/core';
import { CURVE_NO_CAP, settlementStage } from '@merces/domain';
import { defineRoute } from '../app.ts';
import type { AppContext } from '../context.ts';
import { reportingRow, seriesRow } from '../serialize.ts';

const listQuery = z.object({ chain: z.string().optional(), status: z.string().optional(), issuer: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  defineRoute(app, ctx, { method: 'GET', url: '/chains/:chain/fx-pairs', access: 'public', handler: async (req) => {
    const chain = (req.params as { chain: string }).chain;
    if (!ctx.chains.chains.has(chain)) throw AppError.notFound('chain');
    const r = await ctx.pool.query('select pair as "pairId", pyth_feed_id as "feedId", inverted, chainlink_feed as crosscheck, crosscheck_effective_period as "effectivePeriod" from rate_pairs where chain = $1 and enabled and crosscheck_effective_period is not null order by pair', [chain]);
    return { chain, pairs: r.rows };
  } });
  defineRoute(app, ctx, {
    method: 'GET', url: '/health', access: 'public',
    handler: async () => {
      const chains = [] as { chain: string; family: string; mode: string; ok: boolean; detail: string; cursor: string | null; lastSeq: number }[];
      for (const c of ctx.chains.chains.values()) {
        const h = await c.health();
        const cur = await ctx.pool.query<{ cursor: string | null; last_seq: string }>('select cursor, last_seq from indexer_cursors where chain = $1', [c.chain]);
        chains.push({ chain: c.chain, family: c.family, mode: c.mode, ok: h.ok, detail: h.detail, cursor: cur.rows[0]?.cursor ?? null, lastSeq: Number(cur.rows[0]?.last_seq ?? 0) });
      }
      return { ok: chains.every((c) => c.ok), chains, stage1: ctx.chains.stage1 ? { kind: ctx.chains.stage1.kind, path: ctx.chains.stage1.path } : null };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/chains', access: 'public',
    handler: async () => {
      const out = [];
      for (const c of ctx.chains.chains.values()) {
        const info = await c.info();
        // `signing`: the deployment's signing domain (S4 D6), null while the chain's adapter cannot read it
        out.push({ chain: info.chain, family: info.family, mode: info.mode, network: info.network, stablecoins: Object.entries(info.stablecoins).map(([symbol, v]) => ({ symbol, mint: v!.mint, decimals: v!.decimals })), raiseStyles: info.family === 'solana' ? ['sealed', 'curve'] : ['sealed'], signing: info.signing });
      }
      return { chains: out };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/chains/:chain/signer-keys', access: 'public',
    handler: async (req) => {
      const { chain: key } = req.params as { chain: string };
      const { kind } = z.object({ kind: z.enum(['attestor', 'verifier']) }).parse(req.query);
      const chain = ctx.chains.chains.get(key);
      if (!chain) throw AppError.notFound('chain');
      // the chain's key registry (S4 WP5-WP7), read live: each key's 20-byte address, whether it is active, its
      // forward-only revocation time and the end of its grace for report and FX signatures. Public onchain data; never
      // the account a key is linked to
      const keys = await chain.listSignerKeys(kind);
      return { chain: chain.chain, kind, keys: keys.map((k) => ({ address: k.address, active: k.active, revokedAt: k.revokedAt, graceUntil: k.graceUntil })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/issuers', access: 'public',
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const r = await ctx.pool.query(
        `select i.chain, i.issuer, i.registered_at, i.active, i.issuance_stopped, count(s.series_id)::int as series_count,
                coalesce(sum(case when s.phase = 'Settled' then 1 else 0 end), 0)::int as live_series
         from issuers i left join series s on s.chain = i.chain and s.issuer = i.issuer
         where ($1::text is null or i.chain = $1) group by i.chain, i.issuer, i.registered_at, i.active, i.issuance_stopped order by i.registered_at desc limit $2 offset $3`,
        [q.chain ?? null, q.limit, q.offset],
      );
      return { issuers: r.rows.map((x) => ({ issuerId: `${x.chain}:${x.issuer}`, chain: x.chain, address: x.issuer, registeredAt: Number(x.registered_at), active: x.active, issuanceStopped: x.issuance_stopped, seriesCount: x.series_count, liveSeries: x.live_series })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/issuers/:issuerId', access: 'public',
    handler: async (req) => {
      const { issuerId } = req.params as { issuerId: string };
      const i = issuerId.indexOf(':');
      const chain = issuerId.slice(0, i);
      const address = issuerId.slice(i + 1);
      const r = await ctx.pool.query('select * from issuers where chain = $1 and issuer = $2', [chain, address]);
      const row = r.rows[0];
      if (!row) throw AppError.notFound('issuer');
      const series = await ctx.pool.query('select * from series where chain = $1 and issuer = $2 order by created_at', [chain, address]);
      return { issuerId, chain, address, registeredAt: Number(row.registered_at), active: row.active, issuanceStopped: row.issuance_stopped, series: series.rows.map(seriesRow) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series', access: 'public',
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const r = await ctx.pool.query('select * from series where ($1::text is null or chain = $1) and ($2::text is null or status = $2) and ($3::text is null or issuer = $3) order by created_at desc limit $4 offset $5', [q.chain ?? null, q.status ?? null, q.issuer ?? null, q.limit, q.offset]);
      return { series: r.rows.map(seriesRow) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId', access: 'public',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const r = await ctx.pool.query('select * from series where series_id = $1', [seriesId]);
      if (!r.rows[0]) throw AppError.notFound('series');
      const holders = await ctx.pool.query<{ n: number }>('select count(*)::int as n from positions where series_id = $1 and units > 0', [seriesId]);
      const curve = await ctx.pool.query('select * from curves where series_id = $1', [seriesId]);
      // a curve series' curve as indexed (Stage 1's activation, completion and collections; the live pool is
      // GET /series/{id}/curve): the pool, its target, P0, units sold (base lamports), whether it filled, and the proceeds
      const c = curve.rows[0];
      return {
        ...seriesRow(r.rows[0]), holderCount: holders.rows[0]!.n,
        curve: c
          ? {
            dbcPool: c.dbc_pool, baseMint: c.base_mint, migrationQuoteThreshold: c.migration_quote_threshold, issuePrice: c.issue_price, unitsSold: c.units_sold,
            completed: c.completed, settledAt: c.settled_at === null ? null : Number(c.settled_at), proceeds: c.proceeds, migrationFee: c.migration_fee, surplus: c.surplus, tradingFee: c.trading_fee,
            note: `Curve-mode units have a live public price and earn only when staked. ${CURVE_NO_CAP}`,
          }
          : null,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/auction', access: 'public',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const chain = ctx.chainFor(seriesId);
      const [a, bids, now] = await Promise.all([chain.getAuction(seriesId), chain.listBids(seriesId), chain.now()]);
      if (!a) throw AppError.notFound('series');
      // the chain's auction record (Stage 1's stored `raiseState` beside the display `phase`), where the settlement stands
      // (`stage`, the planner's label) and the end of the current time-bound phase (null outside commit and reveal,
      // so while Settling too: settlement steps have no deadline)
      return { ...a, stage: settlementStage({ auction: a, bids }, now), now, phaseEndsAt: a.phase === 'Open' ? a.commitEndsAt : a.phase === 'Reveal' ? a.revealEndsAt : null };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/signing', access: 'public',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const chain = ctx.chainFor(seriesId);
      // the context every Stage 1 signed message on this series binds (S4 D6, D7), read live from the chain: the
      // deployment's domain, the series key and the four nonces, all public onchain. A signature binds the nonce it was
      // requested over; the services read it again when they accept one. The domain first: a chain whose adapter cannot
      // read it yet has nothing to sign under
      const info = await chain.info();
      if (!info.signing) throw AppError.conflict(`the signing domain of chain ${chain.chain} is not known yet`, { reason: 'signing-domain-unknown' });
      const series = await chain.getSeries(seriesId);
      if (!series) throw AppError.notFound('series');
      return { chain: chain.chain, seriesId, seriesKey: series.seriesKey, domain: info.signing, nonces: series.nonces };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/status', access: 'public',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const r = await ctx.pool.query('select * from series where series_id = $1', [seriesId]);
      const s = r.rows[0];
      if (!s) throw AppError.notFound('series');
      const chain = ctx.chainFor(seriesId);
      // live standings for every reportable quarter (statuses and dates only; amounts need the holder/issuer tier)
      const live = await chain.listPeriods(seriesId);
      const standings = live.map((p) => ({ periodId: p.periodId, reportAccepted: p.reportAccepted, settled: p.settled, standing: p.standing, dueAt: p.dueAt }));
      const history = await ctx.pool.query('select from_status, to_status, block_time from status_history where series_id = $1 order by seq', [seriesId]);
      return { seriesId, status: s.status, phase: s.phase, releasesPaused: s.releases_paused, periods: standings, history: history.rows.map((h) => ({ from: h.from_status, to: h.to_status, at: Number(h.block_time) })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/activity', access: 'public',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }).parse(req.query);
      const r = await ctx.pool.query('select chain, seq, series_id, kind, summary, block_time from activity where series_id = $1 and ($2::bigint is null or seq < $2) order by seq desc limit $3', [seriesId, q.before ?? null, q.limit]);
      return { activity: r.rows.map(activityRow) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/activity', access: 'public',
    handler: async (req) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), chain: z.string().optional() }).parse(req.query);
      const r = await ctx.pool.query('select chain, seq, series_id, kind, summary, block_time from activity where ($1::text is null or chain = $1) order by block_time desc, seq desc limit $2', [q.chain ?? null, q.limit]);
      return { activity: r.rows.map(activityRow) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/arena', access: 'public',
    handler: async () => {
      // The Arena ranks live series by verification tier and standing: raises taking bids or settling, and settled
      // series. No amounts.
      const r = await ctx.pool.query(
        `select s.*, (select count(*) from positions p where p.series_id = s.series_id and p.units > 0)::int as holder_count
         from series s where s.phase in ('Open','Settling','Settled') order by case s.status when 'OnTime' then 0 when 'InGrace' then 1 when 'Paused' then 2 when 'Late' then 3 else 4 end, s.created_at desc limit 100`,
      );
      return {
        arena: r.rows.map((x) => ({
          seriesId: x.series_id, chain: x.chain, issuer: x.issuer, phase: x.phase, status: x.status, stablecoin: x.stablecoin, raiseStyle: x.raise_style, unitsOffered: x.units_offered, unitsOutstanding: x.units_outstanding,
          holderCount: x.holder_count, tierFlags: x.tier_flags, reportingCurrency: x.reporting_currency, lockupEndsAt: x.lockup_ends_at === null ? null : Number(x.lockup_ends_at),
        })),
      };
    },
  });

  // ---- amounts: holder or issuer only
  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/periods', access: 'holder-or-issuer',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const chain = ctx.chainFor(seriesId);
      const live = await chain.listPeriods(seriesId);
      const idx = await ctx.pool.query('select period_id, income_commitment, fx_basis, fx_avg_wad, formal_notice_seq from periods where series_id = $1', [seriesId]);
      const byId = new Map(idx.rows.map((r) => [r.period_id, r]));
      const row = (await ctx.pool.query('select first_period, next_expected_period, last_accepted_period, last_paid_period, open_due_period, open_due_amount::text, formal_notice_emitted_for from series where series_id = $1', [seriesId])).rows[0];
      return {
        periods: live.map((p) => ({ ...p, fxBasis: byId.get(p.periodId)?.fx_basis ?? null, fxAvgWad: byId.get(p.periodId)?.fx_avg_wad ?? null, formalNoticeIssued: byId.get(p.periodId)?.formal_notice_seq != null })),
        reporting: row ? reportingRow(row) : null,
      };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/treasury', access: 'issuer',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const t = await ctx.chainFor(seriesId).getTreasury(seriesId);
      if (!t) throw AppError.notFound('series');
      const flags = await ctx.pool.query<{ enabled: boolean }>("select enabled from feature_flags where name = 'early_draws'");
      return { ...t, earlyDraws: { enabled: flags.rows[0]?.enabled ?? false, note: 'Futarchy-gated early or larger draws are built as a switched-off hook (R7).' } };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/vault', access: 'holder-or-issuer',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const v = await ctx.chainFor(seriesId).getVault(seriesId);
      if (!v) throw AppError.notFound('series');
      return v;
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/holders', access: 'holder-or-issuer',
    handler: async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const r = await ctx.pool.query('select wallet, units, claimed_total, redeemed_units, burned_units from positions where series_id = $1 order by units desc', [seriesId]);
      return { holders: r.rows.map((x) => ({ wallet: x.wallet, units: x.units, claimedTotal: x.claimed_total, redeemedUnits: x.redeemed_units, burnedUnits: x.burned_units })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/payouts', access: 'holder',
    handler: async (req, _reply, session) => {
      const { seriesId } = req.params as { seriesId: string };
      const wallets = session!.wallets.map((w) => w.address);
      const r = await ctx.pool.query("select seq, kind, wallet, amount, period_id, detail, block_time, tx_id from money_events where series_id = $1 and ((kind in ('payout','tail_claim','final_claim','redemption_claim','refund') and wallet = any($2)) or kind in ('payment','tail','extinguishment')) order by seq", [seriesId, wallets]);
      return { payouts: r.rows.map((x) => ({ seq: Number(x.seq), kind: x.kind, wallet: x.wallet, amount: x.amount, periodId: x.period_id, detail: x.detail, at: Number(x.block_time), txId: x.tx_id })) };
    },
  });

  defineRoute(app, ctx, {
    method: 'GET', url: '/series/:seriesId/position', access: 'holder',
    handler: async (req, _reply, session) => {
      const { seriesId } = req.params as { seriesId: string };
      const chain = ctx.chainFor(seriesId);
      const positions = [];
      for (const w of session!.wallets.filter((x) => x.chain === chain.chain)) {
        const p = await chain.getPosition(seriesId, w.address);
        if (p) positions.push(p);
      }
      return { positions };
    },
  });
}

function activityRow(x: Record<string, unknown>): Record<string, unknown> {
  return { chain: x.chain, seq: Number(x.seq), seriesId: x.series_id ?? null, kind: x.kind, summary: x.summary, at: Number(x.block_time) };
}

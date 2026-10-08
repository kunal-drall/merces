import { enqueueOutbox } from '@merces/core';
import { DEFAULTS } from '@merces/domain';
import { deviationBps, utcDayIndex } from '@merces/math';
import { parsedToWad, pythSymbolFor, type ChainlinkPort, type PythPort } from '@merces/ports';
import type { ServiceContext } from '@merces/services';
import type { KeeperJob } from './jobs.ts';

/**
 * E8 — rate keeper. Once per UTC day per currency pair per chain: fetch the Pyth update, check publish time and
 * confidence, cross-check against Chainlink where a feed exists, submit `snapshotRate`, and record the check.
 * Feed ids beyond the confirmed ones are resolved from Hermes at runtime and the pair fails closed when missing.
 * Chainlink has no FX feeds on Monad (verified 2026-10-07), so there the cross-check is recorded as unavailable (A-FX-2).
 */
export interface RateKeeperOptions {
  pyth: PythPort;
  chainlink: ChainlinkPort;
  deviationBandBps?: number;
}

export function rateKeeperJob(opts: RateKeeperOptions): KeeperJob {
  const band = BigInt(opts.deviationBandBps ?? DEFAULTS.fxDeviationBandBps);
  return {
    name: 'rate.snapshot',
    intervalSeconds: 1800,
    async run(ctx) {
      let actions = 0;
      const details: string[] = [];
      for (const chain of ctx.chains.chains.values()) {
        const now = await chain.now();
        const day = utcDayIndex(now);
        // pairs: configured rows plus every non-USD reporting currency of a live series
        const configured = await ctx.pool.query<{ pair: string; pyth_feed_id: string | null; chainlink_feed: string | null; last_snapshot_day: number | null }>('select pair, pyth_feed_id, chainlink_feed, last_snapshot_day from rate_pairs where chain = $1 and enabled', [chain.chain]);
        const pairs = new Map(configured.rows.map((r) => [r.pair, r]));
        for (const s of await chain.listSeries()) {
          if (s.terms.reportingCurrency === 'USD' || s.phase !== 'Settled') continue;
          const pair = `${s.terms.reportingCurrency}/USD`;
          if (!pairs.has(pair)) {
            await ctx.pool.query('insert into rate_pairs (chain, pair) values ($1,$2) on conflict do nothing', [chain.chain, pair]);
            pairs.set(pair, { pair, pyth_feed_id: null, chainlink_feed: null, last_snapshot_day: null });
          }
        }
        for (const [pair, row] of pairs) {
          if (row.last_snapshot_day !== null && row.last_snapshot_day >= day) continue;
          const acc = await chain.getRateAccumulator(pair);
          if (acc?.lastDayIndex !== null && acc?.lastDayIndex !== undefined && acc.lastDayIndex >= day) {
            await ctx.pool.query('update rate_pairs set last_snapshot_day = $3 where chain = $1 and pair = $2', [chain.chain, pair, day]);
            continue;
          }
          try {
            const { symbol, inverted } = pythSymbolFor(pair);
            let feedId = row.pyth_feed_id;
            if (!feedId) {
              feedId = (await opts.pyth.resolveFxFeedIds([symbol]))[symbol] ?? null;
              if (!feedId) throw new Error(`no Pyth feed for ${symbol}; failing closed`);
              await ctx.pool.query('update rate_pairs set pyth_feed_id = $3 where chain = $1 and pair = $2', [chain.chain, pair, feedId]);
            }
            const upd = await opts.pyth.getLatestPriceUpdates([feedId]);
            const parsed = upd.parsed.find((p) => '0x' + p.id.replace(/^0x/, '') === feedId);
            if (!parsed) throw new Error(`Hermes returned no price for ${symbol}`);
            if (now - parsed.price.publish_time > DEFAULTS.maxRateAgeSeconds) throw new Error(`stale price for ${symbol} (published ${now - parsed.price.publish_time}s ago; FX market closed?)`);
            const { rateWad, confWad } = parsedToWad(parsed, inverted);
            // Chainlink cross-check where a feed exists
            let clRate: bigint | null = null;
            let dev: bigint | null = null;
            const cl = await opts.chainlink.latestRoundData(chain.chain, pair);
            if (cl) {
              clRate = (cl.answer * 10n ** 18n) / 10n ** BigInt(cl.decimals);
              dev = deviationBps(rateWad, clRate);
            }
            await ctx.pool.query('insert into fx_cross_checks (chain, pair, day_index, pyth_rate_wad, chainlink_rate_wad, deviation_bps, within_band) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [chain.chain, pair, day, rateWad.toString(), clRate?.toString() ?? null, dev === null ? null : Number(dev), dev === null ? null : dev <= band]);
            if (dev !== null && dev > band) {
              // outside the band: do not snapshot; flag the quarter for an attestor rate (A-FX-2)
              const periodId = periodIdOf(now);
              await chain.submit({ kind: 'flagFxFallback', pair, periodId, reason: 'deviation' }, 'keeper').catch(() => undefined);
              await ctx.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5) on conflict (chain, pair, period_id) do nothing', [ctx.newId('fxreq'), chain.chain, pair, periodId, 'deviation']);
              await enqueueOutbox(ctx.pool, 'notification', { kind: 'fx.deviation', chain: chain.chain, pair, deviationBps: Number(dev) });
              details.push(`${chain.chain} ${pair}: deviation ${dev} bps > ${band}`);
              await ctx.pool.query('update rate_pairs set last_snapshot_day = $3, last_error = $4 where chain = $1 and pair = $2', [chain.chain, pair, day, `deviation ${dev} bps`]);
              continue;
            }
            await chain.submit({ kind: 'snapshotRate', pair, rateWad: rateWad.toString(), confWad: confWad.toString(), publishTime: parsed.price.publish_time, update: upd.binary.data[0] ?? null }, 'keeper');
            await ctx.pool.query('update rate_pairs set last_snapshot_day = $3, last_error = null, updated_at = now() where chain = $1 and pair = $2', [chain.chain, pair, day]);
            actions++;
          } catch (e) {
            await ctx.pool.query('update rate_pairs set last_error = $3, updated_at = now() where chain = $1 and pair = $2', [chain.chain, pair, String((e as Error).message).slice(0, 300)]);
            details.push(`${chain.chain} ${pair}: ${(e as Error).message}`);
          }
        }
      }
      return { actions, detail: details.length ? details.join('; ') : undefined };
    },
  };
}

function periodIdOf(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

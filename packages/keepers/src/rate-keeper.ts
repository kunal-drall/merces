import { enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import { wallet32Of, type Command } from '@merces/domain';
import { DEFAULT_PARAMETERS, deviates, invertRate, utcDayIndex } from '@merces/math';
import { parsedToWad, pythUpdateHex, type ChainlinkPort, type PythPort } from '@merces/ports';
import type { KeeperJob } from './jobs.ts';

/** A closed FX market is routine, unlike a missing feed or a failed submission. */
class MarketClosed extends Error {}
export interface RateKeeperOptions { pyth: PythPort; chainlink: ChainlinkPort }
type PairRow = { pair: string; pyth_feed_id: string; chainlink_feed: string | null; inverted: boolean; last_snapshot_day: number | null };

/** SPEC §6.6: registered feed identities, daily raw-price snapshots, retained prices on deviation. */
export function rateKeeperJob(opts: RateKeeperOptions): KeeperJob {
  return {
    name: 'rate.snapshot', requiresSigner: true, intervalSeconds: 1800,
    async run(ctx) {
      let actions = 0;
      const details: string[] = [], errors: string[] = [];
      for (const chain of ctx.chains.chains.values()) {
        try {
          const [now, info] = await Promise.all([chain.now(), chain.info()]);
          // Disabled registry pairs still serve existing series. Registration, not a symbol guess, supplies identity.
          const configured = await ctx.pool.query<PairRow>('select pair, pyth_feed_id, chainlink_feed, inverted, last_snapshot_day from rate_pairs where chain = $1 and crosscheck_effective_period is not null', [chain.chain]);
          const day = utcDayIndex(now);
          for (const row of configured.rows) {
            const pair = row.pair;
            if (row.last_snapshot_day !== null && row.last_snapshot_day >= day) continue;
            try {
              const acc = await chain.getRateAccumulator(pair);
              if (!acc) throw new Error('registered FX pair is not available on chain');
              if (acc.lastDayIndex !== null && acc.lastDayIndex >= day) {
                await ctx.pool.query('update rate_pairs set last_snapshot_day = $3 where chain = $1 and pair = $2', [chain.chain, pair, day]);
                continue;
              }
              if (info.mode === 'live' && opts.pyth.provider === 'mock') throw new Error('mock price feeds are refused on live chains');
              const crossId = info.family === 'solana' && row.chainlink_feed ? '0x' + Buffer.from(wallet32Of(row.chainlink_feed, 'solana')).toString('hex') : null;
              const upd = await opts.pyth.getLatestPriceUpdates(crossId ? [row.pyth_feed_id, crossId] : [row.pyth_feed_id]);
              const lookup = (id: string) => upd.parsed.find((p) => '0x' + p.id.replace(/^0x/, '').toLowerCase() === id.toLowerCase());
              const parsed = lookup(row.pyth_feed_id);
              if (!parsed) throw new Error(`Hermes returned no price for ${row.pyth_feed_id}`);
              if (BigInt(now - parsed.price.publish_time) > DEFAULT_PARAMETERS.fxMaxStalenessSeconds) throw new MarketClosed(`stale price (published ${now - parsed.price.publish_time}s ago; FX market closed?)`);
              const { rateWad } = parsedToWad(parsed, row.inverted);
              const command: Extract<Command, { kind: 'snapshotFx' }> = { kind: 'snapshotFx', pairId: pair, price: parsed.price.price, conf: parsed.price.conf, expo: parsed.price.expo, publishTime: String(parsed.price.publish_time), updates: pythUpdateHex(upd.binary) };
              let crossRate: bigint | null = null;
              if (crossId) {
                const cross = lookup(crossId);
                if (!cross) throw new Error('configured Solana cross-check update is required');
                if (BigInt(now - cross.price.publish_time) > DEFAULT_PARAMETERS.fxMaxStalenessSeconds) throw new MarketClosed('stale cross-check price');
                crossRate = parsedToWad(cross, row.inverted).rateWad;
                Object.assign(command, { crosscheckPrice: cross.price.price, crosscheckExpo: cross.price.expo, crosscheckPublishTime: String(cross.price.publish_time) });
              } else if (row.chainlink_feed) {
                if (info.mode === 'live' && opts.chainlink.provider === 'mock') throw new Error('mock cross-check feeds are refused on live chains');
                const cl = await opts.chainlink.latestRoundData(chain.chain, row.chainlink_feed);
                // MercesFxAccumulator._chainlink: invalid or stale answers do not flag the period.
                if (cl && cl.answer > 0n && cl.decimals <= 36 && BigInt(cl.updatedAt) + DEFAULT_PARAMETERS.fxMaxStalenessSeconds >= BigInt(now)) {
                  const normalized = cl.answer * 10n ** 18n / 10n ** BigInt(cl.decimals);
                  if (normalized > 0n) {
                    crossRate = row.inverted ? invertRate(normalized) : normalized;
                    Object.assign(command, { crosscheckPrice: cl.answer.toString(), crosscheckExpo: -cl.decimals, crosscheckPublishTime: String(cl.updatedAt) });
                  }
                }
              }
              const deviation = crossRate === null ? null : (rateWad > crossRate ? rateWad - crossRate : crossRate - rateWad) * 10000n / crossRate;
              const outside = crossRate !== null && deviates(rateWad, crossRate, DEFAULT_PARAMETERS.fxDeviationBandBps);
              // Chain verification precedes local markers; failures remain retryable. A deviating price still accumulates.
              await chain.submit(command, 'keeper');
              await withTransaction(ctx.pool, async (db) => {
                await db.query('insert into fx_cross_checks (chain,pair,day_index,pyth_rate_wad,chainlink_rate_wad,deviation_bps,within_band) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [chain.chain, pair, day, rateWad.toString(), crossRate?.toString() ?? null, deviation === null ? null : Number(deviation), crossRate === null ? null : !outside]);
                if (outside) {
                  const date = new Date(now * 1000), period = `${date.getUTCFullYear()}Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
                  await db.query('insert into fx_fallback_requests (request_id,chain,pair,period_id,reason) values ($1,$2,$3,$4,$5) on conflict (chain,pair,period_id) do nothing', [ctx.newId('fxreq'), chain.chain, pair, period, 'deviation']);
                  await enqueueOutbox(db, 'notification', { kind: 'fx.deviation', chain: chain.chain, pair, deviationBps: Number(deviation) });
                }
                await db.query('update rate_pairs set last_snapshot_day = $3, last_error = null, updated_at = now() where chain = $1 and pair = $2', [chain.chain, pair, day]);
              });
              if (outside) details.push(`${chain.chain} ${pair}: deviation ${deviation} bps; snapshot retained, quarter flagged`);
              actions++;
            } catch (e) {
              const message = String((e as Error).message).slice(0, 300);
              await ctx.pool.query('update rate_pairs set last_error = $3, updated_at = now() where chain = $1 and pair = $2', [chain.chain, pair, message]);
              (e instanceof MarketClosed ? details : errors).push(`${chain.chain} ${pair}: ${message}`);
            }
          }
        } catch (e) { errors.push(`${chain.chain}: ${String((e as Error).message).slice(0, 200)}`); }
      }
      return { actions, detail: details.length ? details.join('; ') : undefined, errors };
    },
  };
}

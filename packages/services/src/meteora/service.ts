import { AppError, audit } from '@merces/core';
import type { UnsignedTx } from '@merces/domain';
import type { DexPort, MeteoraPort } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E14 — Meteora support (Solana only; R35). Orchestrates curve-mode series: runs Stage 1's oracle-driven config
 * generator through the Meteora port, monitors the curve and its graduation, builds buys and the USDG→USDC swap
 * route through the DEX port. Surfaces clearly that curve-mode units have a live public price and no transfer
 * limits after graduation.
 */
export const CURVE_NOTICE = 'Curve-mode units have a live public price and no transfer limits after graduation. They are not sealed-bid HEUs: holdings are not allowlisted or capped after the curve graduates.';

export class MeteoraService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly meteora: MeteoraPort,
    private readonly dex: DexPort,
  ) {}

  private async curveSeries(seriesId: string) {
    const chain = this.ctx.chainFor(seriesId);
    if (chain.family !== 'solana') throw AppError.unprocessable('curve-mode raises exist on Solana only');
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.terms.raiseStyle !== 'curve') throw AppError.conflict('not a curve-mode series');
    return { chain, series: s };
  }

  /** Run the config generator and persist the config for the series (issuer). */
  async configure(seriesId: string, session: Session): Promise<Record<string, unknown>> {
    const { chain, series } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === series.issuer) && !session.roles.includes('admin')) throw AppError.forbidden('not the issuer');
    const existing = await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId]);
    if (existing.rows[0]) return this.view(existing.rows[0]);
    const info = await chain.info();
    const usdc = info.stablecoins.USDC?.mint;
    if (!usdc) throw AppError.unprocessable('USDC not available on this chain');
    const cfg = await this.meteora.generateConfig({ seriesId, quoteMint: usdc, migrationQuoteThreshold: series.terms.minimumRaise, initialPricePerUnit: series.terms.reservePrice, totalSupplyUnits: series.terms.unitsOffered });
    const badge = await this.meteora.tokenBadgeRequired(usdc);
    const pool = (await this.meteora.getPoolState(`pool_${cfg.configKey}`)) ? `pool_${cfg.configKey}` : null;
    await this.ctx.pool.query('insert into curve_configs (series_id, config_key, pool, params, generated_by, quote_mint, token_badge_required) values ($1,$2,$3,$4,$5,$6,$7) on conflict (series_id) do nothing', [seriesId, cfg.configKey, pool, JSON.stringify(cfg.params), cfg.generatedBy, usdc, badge]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'issuer', action: 'curve.configure', target: seriesId, detail: { configKey: cfg.configKey, generatedBy: cfg.generatedBy } });
    return this.view((await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0]);
  }

  private view(r: Record<string, unknown>): Record<string, unknown> {
    return { seriesId: r.series_id, configKey: r.config_key, pool: r.pool, params: r.params, generatedBy: r.generated_by, quoteMint: r.quote_mint, tokenBadgeRequired: r.token_badge_required, notice: CURVE_NOTICE };
  }

  /** Curve status for anyone: progress toward graduation, spot price, the notice. */
  async status(seriesId: string): Promise<Record<string, unknown>> {
    const { chain } = await this.curveSeries(seriesId);
    const onchain = await chain.getCurve(seriesId);
    const cfg = (await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0];
    const pool = cfg?.pool ? await this.meteora.getPoolState(cfg.pool) : null;
    return { seriesId, onchain, pool, configured: !!cfg, notice: CURVE_NOTICE, graduationMonitor: await this.lastGraduationCheck(seriesId) };
  }

  /** Quote and build a buy on the curve (backer). With USDG as the pay-in currency, returns the swap route first. */
  async buildBuy(seriesId: string, session: Session, buyer: string, amountIn: string, payIn: 'USDC' | 'USDG', slippageBps: number): Promise<Record<string, unknown>> {
    const { chain, series } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === buyer) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
    // the backer tier passes on any eligible wallet of the account; the buying wallet itself must be approved on this chain
    if (!(await chain.isAllowlisted(buyer))) throw AppError.forbidden('buyers must be allowlisted');
    // refuse before any swap is built: a USDG buyer would otherwise swap for real and then have the buy revert
    if (['Retired', 'Redeemed', 'Extinguished'].includes(series.status)) throw AppError.conflict(`series is ${series.status}; curve buys are closed`);
    if (series.phase === 'Cancelled' || series.phase === 'Failed') throw AppError.conflict(`raise is ${series.phase}; curve buys are closed`);
    if ((await chain.getCurve(seriesId))?.graduated) throw AppError.conflict('the curve has graduated; buy on the DEX pool');
    const info = await chain.info();
    const usdc = info.stablecoins.USDC!.mint;
    let swap: Record<string, unknown> | null = null;
    let usdcAmount = amountIn;
    if (payIn === 'USDG') {
      const usdg = info.stablecoins.USDG?.mint;
      if (!usdg) throw AppError.unprocessable('USDG not available on this chain');
      const q = await this.dex.quote({ inputMint: usdg, outputMint: usdc, amount: amountIn, slippageBps, taker: buyer });
      const built = await this.dex.buildSwap(q.orderId);
      usdcAmount = q.outAmount;
      swap = { provider: this.dex.provider, quote: q, transactionBase64: built.transactionBase64, expiresAt: built.expiresAt, note: 'Sign and send this swap first; the curve quotes in USDC.' };
    }
    const cfg = (await this.ctx.pool.query('select pool from curve_configs where series_id = $1', [seriesId])).rows[0];
    const quote = cfg?.pool ? await this.meteora.quoteBuy(cfg.pool, usdcAmount) : null;
    const minUnitsOut = quote ? ((BigInt(quote.unitsOut) * BigInt(10_000 - slippageBps)) / 10_000n).toString() : '0';
    const tx: UnsignedTx = await chain.build({ kind: 'buyCurve', seriesId, amountIn: usdcAmount, minUnitsOut }, buyer);
    return { seriesId, payIn, amountIn, usdcAmount, quote, minUnitsOut, swap, tx, series: { status: series.status, phase: series.phase }, notice: CURVE_NOTICE };
  }

  /** Keeper/admin: check graduation and crank the chain when the curve crossed the threshold. */
  async monitorGraduation(): Promise<{ checked: number; graduated: string[] }> {
    const graduated: string[] = [];
    let checked = 0;
    for (const chain of this.ctx.chains.chains.values()) {
      if (chain.family !== 'solana') continue;
      for (const s of await chain.listSeries()) {
        if (s.terms.raiseStyle !== 'curve') continue;
        checked++;
        const c = await chain.getCurve(s.seriesId);
        const cfg = (await this.ctx.pool.query('select pool from curve_configs where series_id = $1', [s.seriesId])).rows[0];
        const pool = cfg?.pool ? await this.meteora.getPoolState(cfg.pool) : null;
        await this.ctx.pool.query('insert into curve_monitor (series_id, checked_at, raised, graduated, pool_progress_bps) values ($1, now(), $2, $3, $4)', [s.seriesId, c?.raised ?? '0', c?.graduated ?? false, pool?.progressBps ?? null]);
        if (c && !c.graduated && BigInt(c.raised) >= BigInt(c.graduationThreshold)) {
          try {
            await chain.submit({ kind: 'graduateCurve', seriesId: s.seriesId }, 'keeper');
            graduated.push(s.seriesId);
          } catch {
            /* already graduated */
          }
        }
      }
    }
    return { checked, graduated };
  }

  private async lastGraduationCheck(seriesId: string): Promise<Record<string, unknown> | null> {
    const r = await this.ctx.pool.query('select checked_at, raised, graduated, pool_progress_bps from curve_monitor where series_id = $1 order by checked_at desc limit 1', [seriesId]);
    const x = r.rows[0];
    return x ? { checkedAt: x.checked_at, raised: x.raised, graduated: x.graduated, poolProgressBps: x.pool_progress_bps } : null;
  }
}

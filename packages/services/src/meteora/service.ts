import { AppError, audit } from '@merces/core';
import { CURVE_BUYER_NOTICE, CURVE_NO_CAP, ChainError, curveBuyerNotice, type CurveState, type UnsignedTx } from '@merces/domain';
import type { DexPort, MeteoraPort } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E14 — Meteora support (Solana only; R35). Orchestrates curve-mode series on Stage 1's curve lifecycle (S3 WP8): runs
 * Stage 1's oracle-driven config generator through the Meteora port, reads the curve from the chain (the simulator's
 * stand-in pool until S5), builds trades on the curve and the USDG→USDC swap route through the DEX port, and completes
 * the curve and collects its proceeds once it filled (`completeCurve`, `collectCurveProceeds`, permissionless). Every
 * response carries no cap and the buyer notice (`CURVE_BUYER_NOTICE`, with the curve's own figures).
 */

/**
 * "No cap" as every curve response carries it (owner direction; Stage 1 stores a curve series' wallet cap as 0): no
 * wallet cap object (`walletCap: null`), `noCap: true` and the one statement.
 */
const NO_CAP = { walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP } as const;

/** The buyer notice with the curve's own figures (its fee, its target, Meteora's migration fee); the template without a curve. */
export function curveNotice(c: CurveState | null): string {
  return c ? curveBuyerNotice({ tradingFeeBps: c.tradingFeeBps, target: c.migrationQuoteThreshold, migrationFeePercentage: c.migrationFeePercentage }) : CURVE_BUYER_NOTICE;
}

/** What a wallet that is not approved gets from a curve: it can trade, never earn (Stage 1: registration and staking need the allowlist). */
const NOT_APPROVED =
  'This wallet is not approved (allowlisted): it can buy and sell on the curve, but it cannot register or stake, so its units earn nothing from the series, and it cannot tender them at a redemption. Only selling is open to it.';

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
    const curve = await chain.getCurve(seriesId);
    const existing = await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId]);
    if (existing.rows[0]) return this.view(existing.rows[0], curve);
    const info = await chain.info();
    const usdc = info.stablecoins.USDC?.mint;
    if (!usdc) throw AppError.unprocessable('USDC not available on this chain');
    const cfg = await this.meteora.generateConfig({ seriesId, quoteMint: usdc, migrationQuoteThreshold: series.terms.minimumRaise, initialPricePerUnit: series.terms.reservePrice, totalSupplyUnits: series.terms.unitsOffered });
    const badge = await this.meteora.tokenBadgeRequired(usdc);
    const pool = (await this.meteora.getPoolState(`pool_${cfg.configKey}`)) ? `pool_${cfg.configKey}` : null;
    await this.ctx.pool.query('insert into curve_configs (series_id, config_key, pool, params, generated_by, quote_mint, token_badge_required) values ($1,$2,$3,$4,$5,$6,$7) on conflict (series_id) do nothing', [seriesId, cfg.configKey, pool, JSON.stringify(cfg.params), cfg.generatedBy, usdc, badge]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'issuer', action: 'curve.configure', target: seriesId, detail: { configKey: cfg.configKey, generatedBy: cfg.generatedBy } });
    return this.view((await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0], curve);
  }

  private view(r: Record<string, unknown>, curve: CurveState | null): Record<string, unknown> {
    return { seriesId: r.series_id, configKey: r.config_key, pool: r.pool, params: r.params, generatedBy: r.generated_by, quoteMint: r.quote_mint, tokenBadgeRequired: r.token_badge_required, ...NO_CAP, notice: curveNotice(curve) };
  }

  /**
   * Curve status for anyone: the curve as the chain reads it (`CurveState`: the pool's target and progress, P0, the fill,
   * the completion and what was collected), the Meteora port's pool when configured, no cap, the buyer notice and the
   * last monitor check.
   */
  async status(seriesId: string): Promise<Record<string, unknown>> {
    const { chain } = await this.curveSeries(seriesId);
    const onchain = await chain.getCurve(seriesId);
    const cfg = (await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0];
    const pool = cfg?.pool ? await this.meteora.getPoolState(cfg.pool) : null;
    return { seriesId, onchain, pool, configured: !!cfg, ...NO_CAP, notice: curveNotice(onchain), graduationMonitor: await this.lastGraduationCheck(seriesId) };
  }

  /**
   * Quote and build a buy on the curve (a `curveSwap` buy; a Meteora DBC swap on a live chain). With USDG as the pay-in
   * currency, returns the swap route first. Any wallet may buy (Stage 1 has no allowlist on the curve and no cap): a
   * wallet that is not approved gets `earns: false` and a warning, not a refusal (owner question 3's default). 409 once
   * the curve filled (its units trade on the DEX pool).
   */
  async buildBuy(seriesId: string, session: Session, buyer: string, amountIn: string, payIn: 'USDC' | 'USDG', slippageBps: number): Promise<Record<string, unknown>> {
    const { chain, series } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === buyer) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
    const curve = await chain.getCurve(seriesId);
    // refuse before any swap is built: a USDG buyer would otherwise swap for real and then have the buy revert
    if (!curve || curve.poolComplete) throw AppError.conflict('the curve has filled; its units trade on the DEX pool');
    // no cap (owner direction; Stage 1 stores 0): a wallet buys any amount, whatever it already holds
    const earns = await chain.isAllowlisted(buyer);
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
    let quote;
    try {
      quote = await chain.quoteCurveSwap(seriesId, 'buy', usdcAmount);
    } catch (e) {
      if (e instanceof ChainError && (e.code === 'InvalidTerms' || e.code === 'WrongPhase')) throw AppError.conflict(`cannot buy: ${e.message}`);
      throw e;
    }
    const minimumAmountOut = ((BigInt(quote.amountOut) * BigInt(10_000 - slippageBps)) / 10_000n).toString();
    const tx: UnsignedTx = await chain.build({ kind: 'curveSwap', seriesId, side: 'buy', amountIn: usdcAmount, minimumAmountOut }, buyer);
    return {
      seriesId, payIn, amountIn, usdcAmount, quote, minimumAmountOut, swap, tx, earns, warning: earns ? null : NOT_APPROVED,
      series: { status: series.status, phase: series.phase }, ...NO_CAP, notice: curveNotice(curve),
    };
  }

  /**
   * Keeper/admin: for every curve series, record what the curve reads, then crank Stage 1's permissionless lifecycle:
   * `completeCurve` once the pool filled while the raise is Open, then `collectCurveProceeds` while proceeds or trading
   * fees wait in the pool. A step the chain refuses as already done (another sender got there first) is skipped.
   */
  async monitorGraduation(): Promise<{ checked: number; completed: string[]; collected: string[] }> {
    const completed: string[] = [];
    const collected: string[] = [];
    let checked = 0;
    for (const chain of this.ctx.chains.chains.values()) {
      if (chain.family !== 'solana') continue;
      for (const s of await chain.listSeries()) {
        if (s.terms.raiseStyle !== 'curve') continue;
        checked++;
        const c = await chain.getCurve(s.seriesId);
        if (!c) continue;
        const actions: string[] = [];
        const step = async (kind: 'completeCurve' | 'collectCurveProceeds'): Promise<boolean> => {
          try {
            await chain.submit({ kind, seriesId: s.seriesId }, 'keeper');
            actions.push(kind);
            return true;
          } catch (e) {
            if (e instanceof ChainError && ['WrongPhase', 'TooEarly'].includes(e.code)) return false; // already done
            throw e;
          }
        };
        if (c.poolComplete && s.phase === 'Open' && (await step('completeCurve'))) completed.push(s.seriesId);
        const proceedsWaiting = c.poolComplete && c.collected.migrationFee === '0';
        if ((proceedsWaiting || BigInt(c.tradingFeeUncollected) > 0n) && (await step('collectCurveProceeds'))) collected.push(s.seriesId);
        await this.ctx.pool.query(
          'insert into curve_monitor (series_id, checked_at, quote_reserve, pool_complete, settled, pool_progress_bps, actions) values ($1, now(), $2, $3, $4, $5, $6)',
          [s.seriesId, c.quoteReserve, c.poolComplete, c.settled || actions.includes('completeCurve'), c.progressBps, actions],
        );
      }
    }
    return { checked, completed, collected };
  }

  private async lastGraduationCheck(seriesId: string): Promise<Record<string, unknown> | null> {
    const r = await this.ctx.pool.query('select checked_at, quote_reserve::text, pool_complete, settled, pool_progress_bps, actions from curve_monitor where series_id = $1 order by checked_at desc, id desc limit 1', [seriesId]);
    const x = r.rows[0];
    return x ? { checkedAt: x.checked_at, quoteReserve: x.quote_reserve, poolComplete: x.pool_complete, settled: x.settled, poolProgressBps: x.pool_progress_bps, actions: x.actions } : null;
  }
}

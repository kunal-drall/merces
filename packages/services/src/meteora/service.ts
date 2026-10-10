import { AppError, audit } from '@merces/core';
import { CURVE_BUYER_NOTICE, CURVE_NO_CAP, ChainError, curveBuyerNotice, type CurveState, type UnsignedTx } from '@merces/domain';
import type { DexPort, MeteoraPort } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { censusLockedBy } from '../curve-census.ts';
import { advanceCurves, type CurveLifecyclePass } from './lifecycle.ts';

/**
 * E14 — Meteora support (Solana only; R35). Orchestrates curve-mode series on Stage 1's curve lifecycle (S3 WP8): runs
 * Stage 1's oracle-driven config generator through the Meteora port, reads the curve from the chain (the simulator's
 * stand-in pool until S5) and builds trades on the curve and the USDG→USDC swap route through the DEX port. The keepers
 * complete the curve and collect its proceeds (`curve.lifecycle`, `advanceCurves` in ./lifecycle.ts; the admin monitor
 * triggers the same pass). Every response carries no cap and the buyer notice (`CURVE_BUYER_NOTICE`, with the curve's
 * own figures).
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
   * last recorded lifecycle check (`graduationMonitor`: a check by the keepers or the admin monitor that sent a step or
   * read a change, with the chain's time).
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
   * The curve's census (`syncCurveUnits`, Stage 1 `sync_curve_units`, permissionless) as an unsigned transaction for
   * `signer`, one of the caller's wallets: what it would store (`census`, the count now and the one stored last) and
   * whether that changes the count (`changes`). Refusals in Stage 1's order before the wallet signs: 409 RaiseNotOpen,
   * 409 TerminalStatus (Retired, Redeemed or Extinguished). Never while the issuer has assembled the report for the
   * series' next expected period and not submitted it: its proof is over the current census, and a census now could
   * change the count and invalidate it (amendment H1): 409 `report-pending` until the report is submitted.
   */
  async buildSync(seriesId: string, session: Session, signer: string): Promise<Record<string, unknown>> {
    const { chain, series } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === signer) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
    if (series.phase !== 'Open' && series.phase !== 'Settled') throw AppError.conflict(`the raise is ${series.phase}`, { stage1: 'RaiseNotOpen' });
    if (['Retired', 'Redeemed', 'Extinguished'].includes(series.status)) throw AppError.conflict(`the series is ${series.status}: its units are no longer counted`, { stage1: 'TerminalStatus' });
    const locked = await censusLockedBy(this.ctx, series);
    if (locked) {
      throw AppError.conflict(`the issuer assembled the ${locked.periodId} report over the current census and has not submitted it: a census now could invalidate its proof`, { reason: 'report-pending', periodId: locked.periodId, reportId: locked.reportId });
    }
    const curve = await chain.getCurve(seriesId);
    const tx = await chain.build({ kind: 'syncCurveUnits', seriesId }, signer);
    return { seriesId, tx, census: curve?.census ?? null, changes: curve ? curve.census.changedSinceSync : true };
  }

  /**
   * The admin monitor: a manual trigger of the keepers' lifecycle job (`curve.lifecycle`, `advanceCurves`): for every
   * curve series, `completeCurve` once the pool filled while the raise is Open, `collectCurveProceeds` once after it
   * filled and weekly while trading fees accrue. A step already done by another sender is skipped; failures come back
   * per series as codes.
   */
  async monitorGraduation(): Promise<CurveLifecyclePass> {
    return advanceCurves(this.ctx);
  }

  private async lastGraduationCheck(seriesId: string): Promise<Record<string, unknown> | null> {
    const r = await this.ctx.pool.query('select checked_at, chain_time, quote_reserve::text, pool_complete, settled, pool_progress_bps, actions from curve_monitor where series_id = $1 order by id desc limit 1', [seriesId]);
    const x = r.rows[0];
    return x ? { checkedAt: x.checked_at, chainTime: x.chain_time === null ? null : Number(x.chain_time), quoteReserve: x.quote_reserve, poolComplete: x.pool_complete, settled: x.settled, poolProgressBps: x.pool_progress_bps, actions: x.actions } : null;
  }
}

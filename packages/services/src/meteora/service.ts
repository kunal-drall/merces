import { AppError, audit } from '@merces/core';
import { ChainError, curveBeforeYouBuy, curveNoticeFigures, type CurveBeforeYouBuy, type CurveState, type UnsignedTx, type UserCommand, type PermissionlessCommand } from '@merces/domain';
import type { DexPort, MeteoraPort } from '@merces/ports';
import { isEligible, type Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { censusLockedBy } from '../curve-census.ts';
import { advanceCurves, type CurveLifecyclePass } from './lifecycle.ts';
import { NO_CAP, curveNoCap, curveNotice } from './notice.ts';

export { NO_CAP, curveNoCap, curveNotice } from './notice.ts';

/**
 * E14 — Meteora support (Solana only; R35). Orchestrates curve-mode series on Stage 1's curve lifecycle (S3 WP8): runs
 * Stage 1's oracle-driven config generator through the Meteora port, reads the curve from the chain (the simulator's
 * stand-in pool until S5) and builds trades on the curve and the USDG→USDC swap route through the DEX port. The keepers
 * complete the curve and collect its proceeds (`curve.lifecycle`, `advanceCurves` in ./lifecycle.ts; the admin monitor
 * triggers the same pass). Every read and builder of a curve carries no cap and the buyer notice (`CURVE_BUYER_NOTICE`,
 * with the curve's own figures; ./notice.ts), the census builder included; the admin monitor, a pass over every curve,
 * carries neither.
 */

/** What a wallet that is not approved gets from a curve: it can trade, never earn (Stage 1: registration and staking need the allowlist). */
export const NOT_APPROVED =
  'This wallet is not approved (allowlisted): it can buy and sell on the curve, but it cannot register or stake, so its units earn nothing from the series, and it cannot tender them at a redemption. Only selling is open to it.';

/** A trade on the curve as the quote and the swap builder take it. */
export interface CurveSwapInput {
  wallet: string;
  side: 'buy' | 'sell';
  /** buy: stablecoin base units in (USDC, or USDG swapped to USDC first); sell: base lamports in */
  amountIn: string;
  payIn: 'USDC' | 'USDG';
  slippageBps: number;
}

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

  /** Only public curve parameters and fresh account addresses enter these builders; income stays on the device. */
  async buildSetup(seriesId: string, session: Session, command: Extract<UserCommand, {kind:'createCurveConfig'|'createCurvePool'|'openRaise'}>) {
    const {chain,series} = await this.curveSeries(seriesId);
    if (command.seriesId !== seriesId || !session.wallets.some(w => w.chain === chain.chain && w.address === series.issuer)) throw AppError.forbidden('not the issuer');
    if (chain.mode !== 'live') throw AppError.conflict('native Meteora setup requires a live Solana test network');
    if (series.phase !== 'Draft') throw AppError.conflict('the curve is already activated');
    if (!await chain.isAllowlisted(series.issuer)) throw AppError.forbidden('issuer wallet is not approved');
    if ((await chain.info()).newRaisesPaused) throw AppError.conflict('new raises are paused');
    return {tx:await chain.build(command,series.issuer),...NO_CAP,notice:curveNotice(await chain.getCurve(seriesId))};
  }

  async buildMigration(seriesId: string, session: Session, signer: string, command: Extract<PermissionlessCommand,{kind:'migrateCurve'}>) {
    const {chain} = await this.curveSeries(seriesId);
    if (command.seriesId !== seriesId || !session.wallets.some(w=>w.chain===chain.chain&&w.address===signer)) throw AppError.forbidden('wallet is not linked');
    return {tx:await chain.build(command,signer),...NO_CAP,notice:curveNotice(await chain.getCurve(seriesId))};
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
    if(chain.mode==='live'&&!curve)throw AppError.conflict('create the Meteora config and pool on the issuer device using Stage 1, then configure its address for this series', {reason:'curve-pool-required'});
    const cfg = chain.mode==='live' ? {configKey:curve!.dbcConfig,params:{quoteMint:usdc,migrationQuoteThreshold:curve!.migrationQuoteThreshold,totalSupplyUnits:series.terms.unitsOffered},generatedBy:'onchain-validated'} : await this.meteora.generateConfig({ seriesId, quoteMint: usdc, migrationQuoteThreshold: series.terms.minimumRaise, initialPricePerUnit: series.terms.reservePrice, totalSupplyUnits: series.terms.unitsOffered });
    const badge = chain.mode==='live'?false:await this.meteora.tokenBadgeRequired(usdc);
    const pool = chain.mode==='live'?curve!.dbcPool:(await this.meteora.getPoolState(`pool_${cfg.configKey}`)) ? `pool_${cfg.configKey}` : null;
    await this.ctx.pool.query('insert into curve_configs (series_id, config_key, pool, params, generated_by, quote_mint, token_badge_required) values ($1,$2,$3,$4,$5,$6,$7) on conflict (series_id) do nothing', [seriesId, cfg.configKey, pool, JSON.stringify(cfg.params), cfg.generatedBy, usdc, badge]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'issuer', action: 'curve.configure', target: seriesId, detail: { configKey: cfg.configKey, generatedBy: cfg.generatedBy } });
    return this.view((await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0], curve);
  }

  private view(r: Record<string, unknown>, curve: CurveState | null): Record<string, unknown> {
    return { seriesId: r.series_id, configKey: r.config_key, pool: r.pool, params: r.params, generatedBy: r.generated_by, quoteMint: r.quote_mint, tokenBadgeRequired: r.token_badge_required, ...NO_CAP, notice: curveNotice(curve) };
  }

  /**
   * Curve status for anyone: the curve as the chain reads it (`CurveState`: the pool's target and progress, P0, the fill,
   * the completion and what was collected, the trading fee and its split), the Meteora port's pool when configured, no
   * cap, the buyer notice, the statements a buyer acknowledges before a buy (`beforeYouBuy`) and the last recorded
   * lifecycle check (`graduationMonitor`: a check by the keepers or the admin monitor that sent a step or read a change,
   * with the chain's time).
   */
  async status(seriesId: string): Promise<Record<string, unknown>> {
    const { chain } = await this.curveSeries(seriesId);
    const onchain = await chain.getCurve(seriesId);
    const cfg = (await this.ctx.pool.query('select * from curve_configs where series_id = $1', [seriesId])).rows[0];
    const pool = chain.mode==='live' ? (onchain?{pool:onchain.dbcPool,configKey:onchain.dbcConfig,quoteRaised:onchain.quoteReserve,unitsSold:onchain.baseSold,spotPrice:onchain.spotPrice,progressBps:onchain.progressBps,graduated:onchain.poolComplete}:null) : cfg?.pool ? await this.meteora.getPoolState(cfg.pool) : null;
    return {
      seriesId, onchain, pool, configured: !!cfg, ...NO_CAP, notice: curveNotice(onchain), beforeYouBuy: onchain ? curveBeforeYouBuy(curveNoticeFigures(onchain)) : null,
      graduationMonitor: await this.lastGraduationCheck(seriesId),
    };
  }

  /**
   * A trade's checks and figures, shared by the pre-buy quote and the swap builder. 403 for a wallet not linked to the
   * caller; 409 once the curve filled (its units trade on the DEX pool), before any swap is quoted or built; a sell pays
   * out USDC (422 for USDG) and needs the units in the wallet (409, `detail.code` InsufficientFunds). A buy paid in USDG
   * is quoted through the DEX port first (the swap itself is built only by the builder). Any wallet may trade (Stage 1
   * has no allowlist on the curve and no cap): `earns` is false for a wallet that is not approved, which gets a
   * `warning` on a buy (owner question 3's default), never a refusal.
   */
  private async prepareSwap(seriesId: string, session: Session, input: CurveSwapInput) {
    const { chain, series } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === input.wallet) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
    const curve = await chain.getCurve(seriesId);
    // refuse before any swap is built: a USDG buyer would otherwise swap for real and then have the buy revert
    if (!curve || curve.poolComplete) throw AppError.conflict('the curve has filled; its units trade on the DEX pool');
    if (input.side === 'sell' && input.payIn !== 'USDC') throw AppError.unprocessable('a sell pays out USDC');
    if (input.side === 'sell') {
      const held = BigInt((await chain.getPosition(seriesId, input.wallet))?.walletUnits ?? '0');
      if (held < BigInt(input.amountIn)) throw AppError.conflict('the wallet holds fewer units than that', { code: 'InsufficientFunds', walletUnits: held.toString() });
    }
    // no cap (owner direction; Stage 1 stores 0): a wallet buys any amount, whatever it already holds
    const earns = await chain.isAllowlisted(input.wallet);
    const info = await chain.info();
    const usdc = info.stablecoins.USDC!.mint;
    let dexQuote: Awaited<ReturnType<DexPort['quote']>> | null = null;
    let usdcAmount = input.amountIn;
    if (input.side === 'buy' && input.payIn === 'USDG') {
      if(chain.mode==='live'&&this.dex.provider==='mock')throw AppError.unprocessable('a testnet DEX route is not configured; pay in USDC',{reason:'dex-provider-unavailable'});
      const usdg = info.stablecoins.USDG?.mint;
      if (!usdg) throw AppError.unprocessable('USDG not available on this chain');
      dexQuote = await this.dex.quote({ inputMint: usdg, outputMint: usdc, amount: input.amountIn, slippageBps: input.slippageBps, taker: input.wallet });
      usdcAmount = dexQuote.outAmount;
    }
    let quote;
    try {
      quote = await chain.quoteCurveSwap(seriesId, input.side, usdcAmount);
    } catch (e) {
      if (e instanceof ChainError && (e.code === 'InvalidTerms' || e.code === 'WrongPhase')) throw AppError.conflict(`cannot ${input.side}: ${e.message}`);
      throw e;
    }
    const minimumAmountOut = ((BigInt(quote.amountOut) * BigInt(10_000 - input.slippageBps)) / 10_000n).toString();
    const beforeYouBuy: CurveBeforeYouBuy | null = input.side === 'buy' ? curveBeforeYouBuy(curveNoticeFigures(curve)) : null;
    const view = {
      seriesId, wallet: input.wallet, side: input.side, payIn: input.payIn, amountIn: input.amountIn, usdcAmount: input.side === 'buy' ? usdcAmount : null, quote, minimumAmountOut,
      earns, warning: input.side === 'buy' && !earns ? NOT_APPROVED : null, beforeYouBuy,
      series: { status: series.status, phase: series.phase }, ...NO_CAP, notice: curveNotice(curve),
    };
    return { chain, view, dexQuote, usdcAmount, minimumAmountOut, beforeYouBuy };
  }

  /**
   * The pre-buy (or pre-sell) quote (owner direction of 2026-10-10): the chain's quote, the minimum out at the slippage,
   * whether the wallet earns (with the `warning` when it is not approved) and, before a buy, the statements the buyer
   * acknowledges (`beforeYouBuy`: first "Unapproved wallets earn nothing and cannot tender.", then the buyer notice with
   * the curve's figures, and their `version`), the notice and no cap. Builds nothing.
   */
  async quoteSwap(seriesId: string, session: Session, input: CurveSwapInput): Promise<Record<string, unknown>> {
    const { view, dexQuote } = await this.prepareSwap(seriesId, session, input);
    return { ...view, swapQuote: dexQuote ? { provider: this.dex.provider, quote: dexQuote } : null };
  }

  /**
   * Build a trade on the curve (a `curveSwap`; a Meteora DBC swap on a live chain), replacing `build-buy`. A buy needs an
   * eligible backer (the `backer` tier's check, owner question 3: the route is `account` tier for sells) and the
   * buyer's acknowledgement of the statements the quote returned: `acknowledged: true` with their `beforeYouBuyVersion`,
   * else 422 `detail.reason` `acknowledgement-required` (value-free) before anything is quoted or built. With USDG as the
   * pay-in currency a buy returns the swap route to sign first. A sell is open to any linked wallet holding the units
   * (selling back is the only exit before the curve fills). Any wallet may buy: `earns: false` warns, never refuses.
   */
  async buildSwap(seriesId: string, session: Session, input: CurveSwapInput & { acknowledged?: boolean; beforeYouBuyVersion?: string }): Promise<Record<string, unknown>> {
    const { chain: ch } = await this.curveSeries(seriesId);
    if (!session.wallets.some((w) => w.chain === ch.chain && w.address === input.wallet) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
    if (input.side === 'buy' && !session.roles.includes('admin') && !((session.roles.includes('backer') || session.roles.includes('issuer')) && (await isEligible(this.ctx, session)))) {
      throw AppError.forbidden('requires backer');
    }
    if (input.side === 'buy') {
      // the acknowledgement is checked against the statements as they stand now, before any swap is built (a filled
      // curve takes no trade at all: 409, as the quote says)
      const curve = await ch.getCurve(seriesId);
      if (!curve || curve.poolComplete) throw AppError.conflict('the curve has filled; its units trade on the DEX pool');
      const current = curveBeforeYouBuy(curveNoticeFigures(curve)).version;
      if (input.acknowledged !== true || input.beforeYouBuyVersion !== current) {
        throw AppError.unprocessable('acknowledge the statements before you buy (GET /series/{seriesId}/curve/quote returns them): acknowledged true with their version', { reason: 'acknowledgement-required' });
      }
    }
    const { chain, view, dexQuote, usdcAmount, minimumAmountOut } = await this.prepareSwap(seriesId, session, input);
    let swap: Record<string, unknown> | null = null;
    if (dexQuote) {
      const built = await this.dex.buildSwap(dexQuote.orderId);
      swap = { provider: this.dex.provider, quote: dexQuote, transactionBase64: built.transactionBase64, expiresAt: built.expiresAt, note: 'Sign and send this swap first; the curve quotes in USDC.' };
    }
    const tx: UnsignedTx = await chain.build({ kind: 'curveSwap', seriesId, side: input.side, amountIn: usdcAmount, minimumAmountOut }, input.wallet);
    return { ...view, swap, tx };
  }

  /**
   * The curve's census (`syncCurveUnits`, Stage 1 `sync_curve_units`, permissionless) as an unsigned transaction for
   * `signer`, one of the caller's wallets: what it would store (`census`, the count now and the one stored last) and
   * whether that changes the count (`changes`). Refusals in Stage 1's order before the wallet signs: 409 RaiseNotOpen,
   * 409 TerminalStatus (Retired, Redeemed or Extinguished). Never while the issuer has assembled the report for the
   * series' next expected period and not submitted it: its proof is over the current census, and a census now could
   * change the count and invalidate it (amendment H1): 409 `report-pending` until the report is submitted. No cap and
   * the buyer notice, as every curve builder.
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
    return { seriesId, tx, census: curve?.census ?? null, changes: curve ? curve.census.changedSinceSync : true, ...curveNoCap(curve) };
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

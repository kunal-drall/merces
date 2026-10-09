import { AppError, audit, getFlag } from '@merces/core';
import { orderCommitment, type ChainPort, type SeriesState, type UnsignedTx } from '@merces/domain';
import { redemptionQuote, walletCapUnits } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * Series lifecycle builders and views that no other module owns:
 *  R6  treasury draw builder and the issuer's release pause
 *  R13 payout claim builder — behind PayoutClaimBuilder so a private implementation (E15) can be added without touching accounting
 *  R14 retirement status (cap progress, burn progress)
 *  R15 redemption quote endpoint, builders and tail tracking
 *  R19 transfer windows: builders and commitment backups, gated by the `transfer_windows` flag (built, switched off)
 */
export interface PayoutClaimBuilder {
  readonly kind: 'public' | 'private';
  build(chain: ChainPort, seriesId: string, holder: string): Promise<UnsignedTx>;
}

/** v1: payment amounts are public onchain; the claim is a plain claimPayout. */
export class PublicPayoutClaimBuilder implements PayoutClaimBuilder {
  readonly kind = 'public' as const;
  build(chain: ChainPort, seriesId: string, holder: string): Promise<UnsignedTx> {
    return chain.build({ kind: 'claimPayout', seriesId }, holder);
  }
}

export class LifecycleService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly claimBuilder: PayoutClaimBuilder = new PublicPayoutClaimBuilder(),
  ) {}

  private async issuerSeries(seriesId: string, session: Session): Promise<{ chain: ChainPort; series: SeriesState }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === s.issuer) && !session.roles.includes('admin')) throw AppError.forbidden('not the issuer');
    return { chain, series: s };
  }
  private requireWallet(session: Session, chain: string, address: string): void {
    if (!session.wallets.some((w) => w.chain === chain && w.address === address) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
  }

  // ---- R6 treasury
  async buildDraw(seriesId: string, session: Session): Promise<{ tx: UnsignedTx; drawable: { index: number; amount: string }[] }> {
    const { chain, series } = await this.issuerSeries(seriesId, session);
    const t = await chain.getTreasury(seriesId);
    const now = await chain.now();
    const drawable = (t?.tranches ?? []).filter((x) => !x.drawn && x.drawableAt !== null && x.drawableAt <= now).map((x) => ({ index: x.index, amount: x.amount }));
    if (t?.paused) throw AppError.conflict(series.releasesPausedByIssuer ? 'releases are paused by the issuer' : 'releases are paused while the series is Late');
    if (!drawable.length) throw AppError.conflict('no tranche is drawable yet');
    return { tx: await chain.build({ kind: 'drawRelease', seriesId }, series.issuer), drawable };
  }
  async buildPauseReleases(seriesId: string, session: Session, paused: boolean): Promise<{ tx: UnsignedTx }> {
    const { chain, series } = await this.issuerSeries(seriesId, session);
    return { tx: await chain.build({ kind: 'pauseReleases', seriesId, paused }, series.issuer) };
  }

  // ---- R13 payouts
  async buildClaim(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; claimable: string; tailClaimable: string; builder: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    const p = await chain.getPosition(seriesId, holder);
    if (!p) throw AppError.notFound('position');
    if (BigInt(p.claimable) + BigInt(p.tailClaimable) === 0n) throw AppError.conflict('nothing to claim');
    return { tx: await this.claimBuilder.build(chain, seriesId, holder), claimable: p.claimable, tailClaimable: p.tailClaimable, builder: this.claimBuilder.kind };
  }

  // ---- R15 redemption
  /** Per-unit gross accepted per full year since settlement, from the indexed money events (D_avg input). */
  private async annualGrossPerUnit(seriesId: string, series: SeriesState, now: number): Promise<bigint[]> {
    if (series.settledAt === null) return [];
    const full = Math.floor((now - series.settledAt) / (365 * 86_400));
    if (full <= 0) return [];
    const r = await this.ctx.pool.query<{ y: number; total: string }>(
      "select floor((block_time - $2) / 31536000)::int as y, sum(amount)::text as total from money_events where series_id = $1 and kind = 'payment' and (detail->>'source') in ('payIn','split') group by 1",
      [seriesId, series.settledAt],
    );
    const by = new Map(r.rows.map((x) => [Number(x.y), BigInt(x.total)]));
    const units = BigInt(series.unitsSold);
    return Array.from({ length: full }, (_, y) => (units > 0n ? (by.get(y) ?? 0n) / units : 0n));
  }

  async quote(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.phase !== 'Settled' || s.issuePrice === null || s.capPerUnit === null) throw AppError.conflict('series has not settled');
    const now = await chain.now();
    const history = await this.annualGrossPerUnit(seriesId, s, now);
    const q = redemptionQuote({ capPerUnit: BigInt(s.capPerUnit), paidPerUnitWad: BigInt(s.paidPerUnitWad), issuePrice: BigInt(s.issuePrice), hurdleWad: BigInt(s.terms.hurdleWad), payoutMultipleK: BigInt(s.terms.payoutMultipleK), settlementTs: s.settledAt!, nowTs: now, annualGrossPerUnit: history });
    const blockers: string[] = [];
    if (s.lockupEndsAt !== null && now < s.lockupEndsAt) blockers.push(`lockup ends at ${s.lockupEndsAt}`);
    if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(s.status)) blockers.push(`status is ${s.status}`);
    for (const p of await chain.listPeriods(seriesId)) if (!p.settled) blockers.push(`period ${p.periodId} must be reported and paid first (A-RED-1)`);
    return {
      seriesId, now, lockupEndsAt: s.lockupEndsAt, unitsOutstanding: s.unitsOutstanding,
      pricePerUnit: q.pricePerUnit.toString(), deposit: (q.pricePerUnit * BigInt(s.unitsOutstanding)).toString(), boundBy: q.boundBy,
      terms: { capRemaining: q.capRemaining.toString(), hurdlePrice: q.hurdlePrice.toString(), payoutTerm: q.payoutTerm === null ? null : q.payoutTerm.toString(), kTimesDavgYears: history.length, hurdleWad: s.terms.hurdleWad, payoutMultipleK: s.terms.payoutMultipleK },
      tailCapPerUnit: q.tailCapPerUnit.toString(), blockers, redeemable: blockers.length === 0,
    };
  }
  async buildRedeem(seriesId: string, session: Session, maxPricePerUnit: string): Promise<{ tx: UnsignedTx; quote: Record<string, unknown> }> {
    const { chain, series } = await this.issuerSeries(seriesId, session);
    const quote = await this.quote(seriesId);
    if (!quote.redeemable) throw AppError.conflict(`cannot redeem: ${(quote.blockers as string[]).join('; ')}`);
    if (BigInt(quote.pricePerUnit as string) > BigInt(maxPricePerUnit)) throw AppError.conflict(`quoted price ${quote.pricePerUnit} exceeds maxPricePerUnit`);
    return { tx: await chain.build({ kind: 'redeem', seriesId, maxPricePerUnit }, series.issuer), quote };
  }
  async buildClaimRedemption(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; units: string; amount: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    const r = await chain.getRedemption(seriesId);
    if (!r) throw AppError.conflict('no redemption open');
    const p = await chain.getPosition(seriesId, holder);
    if (!p || BigInt(p.units) === 0n) throw AppError.conflict('no units to redeem');
    return { tx: await chain.build({ kind: 'claimRedemption', seriesId }, holder), units: p.units, amount: (BigInt(p.units) * BigInt(r.pricePerUnit)).toString() };
  }
  /** Redemption state and tail tracking (C7): window end, cap per unit, tail payouts so far. */
  async redemption(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const r = await chain.getRedemption(seriesId);
    if (!r) return { seriesId, status: s.status, redemption: null, tail: null };
    const now = await chain.now();
    const tail = await this.ctx.pool.query("select period_id, amount, detail->>'perUnit' as per_unit, block_time from money_events where series_id = $1 and kind = 'tail' order by seq", [seriesId]);
    const claims = await this.ctx.pool.query("select count(*)::int as n, coalesce(sum(amount),0)::text as total from money_events where series_id = $1 and kind = 'redemption_claim'", [seriesId]);
    return {
      seriesId, status: s.status, redemption: r,
      tail: { endsAt: r.tailEndsAt, open: now <= r.tailEndsAt && BigInt(r.tailCapPerUnit) > BigInt(r.tailPaidPerUnit), capPerUnit: r.tailCapPerUnit, paidPerUnit: r.tailPaidPerUnit, payouts: tail.rows.map((x) => ({ periodId: x.period_id, total: x.amount, perUnit: x.per_unit, at: Number(x.block_time) })) },
      claims: { count: claims.rows[0]!.n, total: claims.rows[0]!.total },
    };
  }

  // ---- R14 retirement
  async retirement(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const positions = await chain.listPositions(seriesId);
    const unburned = positions.filter((p) => BigInt(p.units) > 0n);
    const cap = s.capPerUnit ? BigInt(s.capPerUnit) : null;
    const paidPerUnit = BigInt(s.paidPerUnitWad) / 10n ** 18n;
    return {
      seriesId, status: s.status, retired: s.status === 'Retired', capPerUnit: s.capPerUnit, paidPerUnit: paidPerUnit.toString(), capProgressBps: cap && cap > 0n ? Number((paidPerUnit * 10_000n) / cap) : 0,
      unitsOutstanding: s.unitsOutstanding, holdersWithUnits: unburned.length, burnable: s.status === 'Retired' || s.status === 'Extinguished', note: 'Units burn on claim or by the permissionless burn crank; burned holders keep their claimable payouts.',
    };
  }

  // ---- R19 transfer windows (built, switched off)
  private async windowsEnabled(): Promise<void> {
    if (!(await getFlag(this.ctx.pool, 'transfer_windows'))) throw AppError.forbidden('transfer windows are switched off until the 18-month lockups end (feature flag transfer_windows)');
  }
  async window(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const w = await chain.getTransferWindow(seriesId);
    const now = await chain.now();
    const enabled = await getFlag(this.ctx.pool, 'transfer_windows');
    if (s.terms.raiseStyle === 'curve') return { seriesId, enabled: false, lockupEndsAt: s.lockupEndsAt, window: null, phase: 'none', walletCapUnits: null, rules: 'Curve-mode units have no transfer windows: after graduation they trade freely on the DEX pool with no wallet cap and no allowlist (A-CURVE-2).' };
    return { seriesId, enabled, lockupEndsAt: s.lockupEndsAt, window: w, phase: !w || w.cleared ? 'none' : now < w.commitEndsAt ? 'commit' : now < w.revealEndsAt ? 'reveal' : 'clear-due', walletCapUnits: walletCapUnits(BigInt(s.unitsOutstanding), BigInt(s.terms.walletCapBps)).toString(), rules: 'Units move only through windows; direct transfers always fail; no lending, AMMs or shorting (C10).' };
  }
  async buildWindowCommit(seriesId: string, session: Session, input: { wallet: string; side: 'buy' | 'sell'; commitment: string; deposit: string; units: string }): Promise<{ tx: UnsignedTx }> {
    await this.windowsEnabled();
    const chain = this.ctx.chainFor(seriesId);
    if ((await chain.getSeries(seriesId))?.terms.raiseStyle === 'curve') throw AppError.conflict('curve units trade on the DEX pool, not in transfer windows');
    this.requireWallet(session, chain.chain, input.wallet);
    const w = await chain.getTransferWindow(seriesId);
    if (!w || w.cleared) throw AppError.conflict('no open window');
    if (input.side === 'buy' && !(await chain.isAllowlisted(input.wallet))) throw AppError.forbidden('buyers must be allowlisted');
    return { tx: await chain.build({ kind: 'commitWindowOrder', seriesId, windowId: w.windowId, side: input.side, commitment: input.commitment, deposit: input.deposit, units: input.units }, input.wallet) };
  }
  async buildWindowReveal(seriesId: string, session: Session, input: { wallet: string; side: 'buy' | 'sell'; pricePerUnit: string; quantity: string; salt: string }): Promise<{ tx: UnsignedTx }> {
    await this.windowsEnabled();
    const chain = this.ctx.chainFor(seriesId);
    if ((await chain.getSeries(seriesId))?.terms.raiseStyle === 'curve') throw AppError.conflict('curve units trade on the DEX pool, not in transfer windows');
    this.requireWallet(session, chain.chain, input.wallet);
    const w = await chain.getTransferWindow(seriesId);
    if (!w || w.cleared) throw AppError.conflict('no open window');
    void orderCommitment;
    return { tx: await chain.build({ kind: 'revealWindowOrder', seriesId, windowId: w.windowId, side: input.side, pricePerUnit: input.pricePerUnit, quantity: input.quantity, salt: input.salt }, input.wallet) };
  }
  async putWindowBackup(seriesId: string, session: Session, wallet: string, ciphertext: string, keyHint: string | null): Promise<{ ok: true }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, wallet);
    if (/"pricePerUnit"|"quantity"|"salt"/.test(ciphertext)) throw AppError.badRequest('backup must be client-encrypted');
    await this.ctx.pool.query('insert into bid_backups (series_id, bidder, account_id, ciphertext, key_hint) values ($1,$2,$3,$4,$5) on conflict (series_id, bidder) do update set ciphertext = excluded.ciphertext, key_hint = excluded.key_hint, updated_at = now()', [`${seriesId}#window`, wallet, session.accountId, ciphertext, keyHint]);
    return { ok: true };
  }
  async getWindowBackup(seriesId: string, session: Session, wallet: string): Promise<{ ciphertext: string; keyHint: string | null }> {
    const r = await this.ctx.pool.query('select ciphertext, key_hint, account_id from bid_backups where series_id = $1 and bidder = $2', [`${seriesId}#window`, wallet]);
    const row = r.rows[0];
    if (!row) throw AppError.notFound('backup');
    if (row.account_id !== session.accountId) throw AppError.forbidden();
    return { ciphertext: row.ciphertext, keyHint: row.key_hint };
  }
  /** Admin/keeper trigger for the burn crank (the scheduler runs it too). */
  async crankBurn(seriesId: string, by: string): Promise<{ burned: number }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.status !== 'Retired' && s.status !== 'Extinguished') throw AppError.conflict(`units are burnable only when Retired or Extinguished (series is ${s.status}; redeemed units burn on claim)`);
    const holders = (await chain.listPositions(seriesId)).filter((p) => BigInt(p.units) > 0n).map((p) => p.wallet);
    if (!holders.length) return { burned: 0 };
    await chain.submit({ kind: 'crankBurn', seriesId, holders }, 'keeper');
    await audit(this.ctx.pool, { actor: by, actorRole: 'admin', action: 'retirement.crank-burn', target: seriesId, detail: { holders: holders.length } });
    return { burned: holders.length };
  }
}

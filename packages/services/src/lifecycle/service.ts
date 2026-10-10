import { AppError, audit, getFlag } from '@merces/core';
import { CURVE_NO_CAP, ChainError, orderCommitment, type ChainPort, type PositionState, type SeriesState, type UnsignedTx } from '@merces/domain';
import { SeriesStatus, WAD, YEAR, capRemaining, fromPid, interim, isTerminal, periodStart, pidAt, redemptionQuoteScaled, toPid, type ErrorName, type YearGrossRing } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * Series lifecycle builders and views that no other module owns:
 *  R6  treasury draw builder and the issuer's release pause
 *  R13 payout claim builder — behind PayoutClaimBuilder so a private implementation (E15) can be added without touching accounting;
 *      the tail and final claim builders and the holder registration builder (S3: Stage 1's claim family)
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
  /**
   * The net payout claim, Stage 1 `claim`: `claimable` is exactly what it pays, on every status. The redemption, the tail
   * and the final-pool share are other claims (`claimRedemption`, `claimTail`, `claimFinal`), never paid by this one. On a
   * Retired series the claim also burns the holder's balance (`burnsUnits`: its units less the auction units not yet
   * delivered and those held for a window ask, which Stage 1 does not burn), so a holder with nothing to be paid but
   * units to burn still gets the claim (a zero claim). Otherwise a claim that would pay 0 and burn nothing is a 409
   * (`nothing-to-claim`) naming the claims that would pay the holder something now (`claimWith`).
   */
  async buildClaim(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; claimable: string; burnsUnits: string; builder: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    const p = await chain.getPosition(seriesId, holder);
    if (!p) throw AppError.notFound('position');
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const burnsUnits = s.status === 'Retired' ? heldUnits(p) : 0n;
    if (BigInt(p.claimable) === 0n && burnsUnits === 0n) throw nothingToClaim('a payout', p, 'claimPayout');
    return { tx: await this.claimBuilder.build(chain, seriesId, holder), claimable: p.claimable, burnsUnits: burnsUnits.toString(), builder: this.claimBuilder.kind };
  }

  /**
   * The tail claim, Stage 1 `claim_tail` (SIM:1403-1417), with its refusals in Stage 1's order so they come before the
   * wallet signs: 409 NotRedeemed until the series redeemed (the redemption alone: an extinguished series that redeemed
   * still pays its tail), 409 HolderNotRegistered, 409 NoRedeemedUnits for a holder that has redeemed nothing and has
   * nothing left to redeem (its units, less those held for a window ask, are 0: a late registration).
   *
   * `amount` is what `TailClaimed` pays (`tailClaimable`, Stage 1's `claimableTail` view). A holder that has redeemed
   * nothing is redeemed first by the same transaction (`redeemsFirst`): its units not held for a window ask, the
   * redemption price on them and their tail catch-up (`amount`, `redemptionClaimable`) and its pending payout
   * (`payout`, `claimable`), in the redemption's own events. `total` is everything the transaction pays the holder;
   * `burnsUnits` the units it burns (the redeemed ones). Like the payout claim, a claim that would pay 0 and burn
   * nothing is a 409 (`nothing-to-claim`, `claimWith` naming the claims that would pay the holder something now): a
   * claim of nothing would only move the holder's tail cursor.
   */
  async buildClaimTail(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; amount: string; redeemsFirst: RedeemsFirst | null; total: string; burnsUnits: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (!(await chain.getRedemption(seriesId))) throw AppError.conflict('the series has not redeemed: no tail is paid before a redemption', { stage1: 'NotRedeemed' });
    const p = await chain.getPosition(seriesId, holder);
    if (!p) throw AppError.notFound('position');
    if (!p.registered) throw AppError.conflict('not a registered holder of this series', { stage1: 'HolderNotRegistered' });
    const redeemable = BigInt(p.units) - BigInt(p.escrowedUnits);
    if (BigInt(p.redeemedUnits) === 0n && redeemable === 0n) throw AppError.conflict('the holder has redeemed no units and has none left to redeem', { stage1: 'NoRedeemedUnits' });
    const redeemsFirst = BigInt(p.redeemedUnits) === 0n ? redemptionPreview(p, redeemable) : null;
    const total = BigInt(p.tailClaimable) + redeemsTotal(redeemsFirst);
    const burnsUnits = redeemsFirst ? redeemable : 0n;
    if (total === 0n && burnsUnits === 0n) throw nothingToClaim('a tail', p, 'claimTail');
    return { tx: await chain.build({ kind: 'claimTail', seriesId }, holder), amount: p.tailClaimable, redeemsFirst, total: total.toString(), burnsUnits: burnsUnits.toString() };
  }

  /**
   * The final claim, Stage 1 `claim_final` (SIM:1449-1475), after an extinguishment: 409 TerminalStatus unless the
   * series is Extinguished, 409 HolderNotRegistered. It delivers a pending auction bid first, then pays the pending payout
   * and the final-pool share once (`FinalClaimed{units: weight, amount}`) and burns the holder's balance.
   *
   * On a series that redeemed, a holder with units not yet redeemed (less those held for a window ask) is redeemed first
   * by the same transaction (`redeemsFirst`: the redemption price and the tail catch-up as `amount`, its pending payout as
   * `payout`, in the redemption's own events) and weighed on its redeemed units; `amount` is then the share alone
   * (`finalClaimable`). Otherwise `amount` is `claimable + finalClaimable` (the pending payout and the share). `total`
   * is everything the transaction pays; `burnsUnits` every unit it burns (the redeemed units included): the holder's
   * units less those held for a window ask. A claim that would pay 0 and burn nothing (a second final claim) is a 409
   * (`nothing-to-claim`).
   */
  async buildClaimFinal(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; amount: string; redeemsFirst: RedeemsFirst | null; total: string; burnsUnits: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.status !== 'Extinguished') throw AppError.conflict(`the final claim opens once the series is extinguished (series is ${s.status})`, { stage1: 'TerminalStatus' });
    const p = await chain.getPosition(seriesId, holder);
    if (!p) throw AppError.notFound('position');
    if (!p.registered) throw AppError.conflict('not a registered holder of this series', { stage1: 'HolderNotRegistered' });
    const balance = BigInt(p.units) - BigInt(p.escrowedUnits);
    const redeemsFirst = (await chain.getRedemption(seriesId)) && balance > 0n ? redemptionPreview(p, balance) : null;
    const amount = BigInt(p.finalClaimable) + (redeemsFirst ? 0n : BigInt(p.claimable));
    const total = amount + redeemsTotal(redeemsFirst);
    if (total === 0n && balance === 0n) throw nothingToClaim('a final share', p, 'claimFinal');
    return { tx: await chain.build({ kind: 'claimFinal', seriesId }, holder), amount: amount.toString(), redeemsFirst, total: total.toString(), burnsUnits: balance.toString() };
  }

  // ---- holder registration
  /**
   * Stage 1 `register_holder` (SIM:618-623) for one of the caller's wallets, which also signs it (the command is
   * permissionless; payouts accrue to registered holders only, from the registration on). A wallet that is already a
   * registered holder of the series gets `{alreadyRegistered: true, tx: null}` and no transaction (the command is
   * idempotent). Otherwise 403 NotAllowlisted for a wallet not on the chain's allowlist (Stage 1's only check). A
   * registration holds no units and grants no holder access (A-REV-10).
   */
  async buildRegister(seriesId: string, session: Session, wallet: string): Promise<{ tx: UnsignedTx | null; alreadyRegistered: boolean }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, wallet);
    if (!(await chain.getSeries(seriesId))) throw AppError.notFound('series');
    if ((await chain.getPosition(seriesId, wallet))?.registered) return { tx: null, alreadyRegistered: true };
    if (!(await chain.isAllowlisted(wallet))) throw AppError.forbidden('the wallet is not on the allowlist: only an allowlisted wallet can be registered as a holder', { stage1: 'NotAllowlisted' });
    return { tx: await chain.build({ kind: 'registerHolder', seriesId, wallet }, wallet), alreadyRegistered: false };
  }

  // ---- R15 redemption
  /**
   * The chain's own quote: Stage 1's `redemptionQuote` over the series' live cap, `paidPerUnitWad` and tagged year ring
   * (`SeriesState.yearGross`), exactly what `redeem` computes at `now`, at the series' unit scale
   * (`redemptionQuoteScaled`, Stage 1's own function at scale 1). `decidedBy` is Stage 1's label
   * (`cap_remaining`, `hurdle`, `payout_multiple`); `boundBy` keeps the version-1 labels (`cap`, `hurdle`, `payout`).
   *
   * The blockers are Stage 1's `redeem` refusals in its own order (SIM:1328-1342), each with its error name in
   * `blockedBy`: TerminalStatus, SeriesLate (a Paused series may redeem), LockupActive, PaymentOutstanding,
   * TrueUpOutstanding (not reachable until the true-up lands, S5) and UnreportedPeriods (every ended period must be
   * reported). With no cap left (`C_remaining = 0`) `redeem` retires the series instead: `outcome` is `retire` and no
   * deposit is taken. 409 before settlement and while the raise is still processing its bids (MintNotFinalized, S2).
   *
   * On a curve series `redeem` takes its own census first, with the DAMM v2 pool's base vault left out (Stage 1
   * exit.rs:80-95, B-C13; S3 WP9), so the deposit's N is that count now (`CurveState.census.redemptionUnits`), not the
   * last regular census; `unitsCounted` says which (`redemption-census`), and a count of 0 is NoUnitsOutstanding.
   */
  async quote(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.phase !== 'Settled' || s.issuePrice === null || s.capPerUnit === null || s.settledAt === null) throw AppError.conflict('series has not settled');
    // the units outstanding (the quote's divisor) are known once the last bid is processed; `redeem` refuses before that
    if (!s.mintFinalized) throw AppError.conflict('the raise is still processing its bids (MintNotFinalized): no redemption quote yet');
    const now = await chain.now();
    const t = BigInt(Math.max(0, now - s.settledAt));
    const ring = s.yearGross.map((y) => ({ year: y.year, grossWad: BigInt(y.grossWad) })) as unknown as YearGrossRing;
    const curve = s.terms.raiseStyle === 'curve' ? await chain.getCurve(seriesId) : null;
    const units = curve ? curve.census.redemptionUnits : s.unitsOutstanding;
    const q = redemptionQuoteScaled({ p0: BigInt(s.issuePrice), hurdleRateWad: BigInt(s.terms.hurdleWad), payoutMultipleK: s.terms.payoutMultipleK, t, capPerUnit: BigInt(s.capPerUnit), paidPerUnitWad: BigInt(s.paidPerUnitWad), yearGross: ring, unitsOutstanding: BigInt(units), unitScale: BigInt(s.unitScale) });
    const boundBy = q.decidedBy === 'cap_remaining' ? 'cap' : q.decidedBy === 'payout_multiple' ? 'payout' : 'hurdle';
    const payoutTerm = q.dAvg === null ? null : BigInt(s.terms.payoutMultipleK) * q.dAvg;
    const { blockers, blockedBy } = redeemBlockers(s, now);
    if (curve && BigInt(units) === 0n) {
      blockedBy.push('NoUnitsOutstanding');
      blockers.push('no units are outstanding: nobody outside the protocol holds units of the curve');
    }
    const retires = q.cRemaining === 0n;
    return {
      seriesId, now, lockupEndsAt: s.lockupEndsAt, unitsOutstanding: units, unitsCounted: curve ? 'redemption-census' : 'units-outstanding',
      pricePerUnit: q.pRedeem.toString(), deposit: q.deposit.toString(), decidedBy: q.decidedBy, boundBy,
      terms: { capRemaining: q.cRemaining.toString(), hurdlePrice: q.pHurdle.toString(), payoutTerm: payoutTerm === null ? null : payoutTerm.toString(), dAvg: q.dAvg === null ? null : q.dAvg.toString(), kTimesDavgYears: Number(t / YEAR), hurdleWad: s.terms.hurdleWad, payoutMultipleK: s.terms.payoutMultipleK },
      tailCapPerUnit: q.tailCapPerUnit.toString(), blockers, blockedBy, redeemable: blockers.length === 0,
      outcome: retires ? 'retire' : 'redeem',
      note: retires ? 'Nothing is left of the cap (C_remaining = 0): redeem retires the series instead; no deposit is taken and no tail follows.' : null,
    };
  }
  async buildRedeem(seriesId: string, session: Session, maxPricePerUnit: string): Promise<{ tx: UnsignedTx; quote: Record<string, unknown> }> {
    const { chain, series } = await this.issuerSeries(seriesId, session);
    const quote = await this.quote(seriesId);
    if (!quote.redeemable) throw AppError.conflict(`cannot redeem: ${(quote.blockers as string[]).join('; ')}`);
    if (BigInt(quote.pricePerUnit as string) > BigInt(maxPricePerUnit)) throw AppError.conflict(`quoted price ${quote.pricePerUnit} exceeds maxPricePerUnit`);
    return { tx: await chain.build({ kind: 'redeem', seriesId, maxPricePerUnit }, series.issuer), quote };
  }
  /**
   * The redemption claim, Stage 1 `claim_redemption` (SIM:1395-1401): 409 NotRedeemed until the series redeemed, 409
   * when the holder has no units left to redeem (its units less those held for a window ask). `units` are the units it
   * redeems (and burns); `amount` is everything it pays: the redemption price on them and their tail catch-up
   * (`redemptionClaimable`) and the holder's pending payout (`claimable`), which the redemption pays too (`payout`; it
   * is `PayoutClaimed` beside `RedemptionClaimed`). A curve series is redeemed by tendering units instead: 409
   * CurveUsesTender.
   */
  async buildClaimRedemption(seriesId: string, session: Session, holder: string): Promise<{ tx: UnsignedTx; units: string; amount: string; redemption: string; payout: string }> {
    const chain = this.ctx.chainFor(seriesId);
    this.requireWallet(session, chain.chain, holder);
    if ((await chain.getSeries(seriesId))?.terms.raiseStyle === 'curve') throw AppError.conflict('a curve-mode series is redeemed by tendering units', { stage1: 'CurveUsesTender' });
    const r = await chain.getRedemption(seriesId);
    if (!r) throw AppError.conflict('no redemption open', { stage1: 'NotRedeemed' });
    const p = await chain.getPosition(seriesId, holder);
    const units = p ? BigInt(p.units) - BigInt(p.escrowedUnits) : 0n;
    if (!p || units === 0n) throw AppError.conflict('no units to redeem');
    const amount = BigInt(p.redemptionClaimable) + BigInt(p.claimable);
    return { tx: await chain.build({ kind: 'claimRedemption', seriesId }, holder), units: units.toString(), amount: amount.toString(), redemption: p.redemptionClaimable, payout: p.claimable };
  }
  /**
   * Redemption state and tail tracking (C7) from Stage 1's tail state: the window end, the tail cap per unit, the tail
   * paid per unit (`paidPerUnitWad`, WAD-scaled; `paidPerUnit` floors it), `exhausted` once the cap is used up, the
   * excess refunded to the issuer and the tail payouts so far. `open`: a tail can still be reported (the next period
   * starts by `endsAt`, Stage 1 TailEnded) and paid (not exhausted, Stage 1 NoTailDue).
   */
  async redemption(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const r = await chain.getRedemption(seriesId);
    if (!r) return { seriesId, status: s.status, redemption: null, tail: null };
    const tail = await this.ctx.pool.query("select period_id, amount, detail->>'perUnit' as per_unit, block_time from money_events where series_id = $1 and kind = 'tail' order by seq", [seriesId]);
    const claims = await this.ctx.pool.query("select count(*)::int as n, coalesce(sum(amount),0)::text as total from money_events where series_id = $1 and kind = 'redemption_claim'", [seriesId]);
    // Stage 1's tail rules (SIM:1072-1073): a period starting after `tailEndsAt` is TailEnded; a liquidity-event report
    // is NoTailDue once the tail cap is used up (`tailExhausted`) or was zero
    const next = s.reporting.nextExpectedPeriod;
    const reportable = next !== null && periodStart(toPid(next)) <= BigInt(r.tailEndsAt);
    const exhausted = r.tailExhausted || BigInt(r.tailCapPerUnit) === 0n;
    return {
      seriesId, status: s.status, redemption: r,
      tail: {
        endsAt: r.tailEndsAt, open: !exhausted && reportable, exhausted: r.tailExhausted, capPerUnit: r.tailCapPerUnit, paidPerUnitWad: r.tailPaidPerUnitWad,
        paidPerUnit: (BigInt(r.tailPaidPerUnitWad) / WAD).toString(), refunded: r.tailRefunded, nextPeriod: next,
        payouts: tail.rows.map((x) => ({ periodId: x.period_id, total: x.amount, perUnit: x.per_unit, at: Number(x.block_time) })),
      },
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
    const paidPerUnit = BigInt(s.paidPerUnitWad) / WAD;
    return {
      seriesId, status: s.status, retired: s.status === 'Retired', capPerUnit: s.capPerUnit, paidPerUnit: paidPerUnit.toString(), capRemaining: cap === null ? null : capRemaining(cap, BigInt(s.paidPerUnitWad)).toString(), capProgressBps: cap && cap > 0n ? Number((paidPerUnit * 10_000n) / cap) : 0,
      unitsOutstanding: s.unitsOutstanding, holdersWithUnits: unburned.length, burnable: s.status === 'Retired' && s.terms.raiseStyle === 'sealed',
      note: s.terms.raiseStyle === 'curve'
        ? 'Curve-mode units are never burned (Stage 1 CurveModeNoBurn): on a Retired curve series holders keep their units and claim what their staked units earned; a redemption burns the units tendered.'
        : 'Units of a Retired series burn on a payout claim (claimPayout, also one that pays nothing) or by the permissionless burnRetired, one holder at a time (the keepers send it for every holder still holding units); units of an Extinguished series burn at the final claim (claimFinal); a redeemed holder\'s units burn at its redemption. Burned holders keep their claimable payouts.',
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
    // a curve series has no transfer windows and no cap at any stage (A-CURVE-2): no window cap, and the one statement
    if (s.terms.raiseStyle === 'curve') return { seriesId, enabled: false, lockupEndsAt: s.lockupEndsAt, window: null, phase: 'none', walletCapUnits: null, noCap: true, noCapStatement: CURVE_NO_CAP, rules: `Curve-mode units have no transfer windows: after graduation they trade freely on the DEX pool, with no allowlist. ${CURVE_NO_CAP}` };
    return { seriesId, enabled, lockupEndsAt: s.lockupEndsAt, window: w, phase: !w || w.cleared ? 'none' : now < w.commitEndsAt ? 'commit' : now < w.revealEndsAt ? 'reveal' : 'clear-due', walletCapUnits: interim.walletCapUnits(BigInt(s.unitsOutstanding), BigInt(s.terms.walletCapBps)).toString(), rules: 'Units move only through windows; direct transfers always fail; no lending, AMMs or shorting (C10).' };
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
  /**
   * Admin trigger for the Retired burn (the `burn.crank` keeper job runs it too): one permissionless `burnRetired` (Stage
   * 1 `burn_retired`) per holder that still holds units (`heldUnits`: a burn of nothing would only emit a burn of 0).
   * A Retired sealed-bid series only: 409 on a curve series (its units never burn, CurveModeNoBurn) and on any other
   * status (Stage 1 refuses it, TerminalStatus). A holder the chain refuses (not registered, HolderNotRegistered) is
   * skipped and counted in `refused`.
   */
  async burnRetiredHolders(seriesId: string, by: string): Promise<{ burned: number; refused: number }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.terms.raiseStyle === 'curve') throw AppError.conflict('curve-mode units are never burned', { stage1: 'CurveModeNoBurn' });
    if (s.status !== 'Retired') throw AppError.conflict(`units are burned by burnRetired only on a Retired series (series is ${s.status}; an extinguished holder's units burn at claimFinal, a redeemed holder's at its redemption)`, { stage1: 'TerminalStatus' });
    const holders = (await chain.listPositions(seriesId)).filter((p) => heldUnits(p) > 0n).map((p) => p.wallet);
    let burned = 0;
    let refused = 0;
    for (const holder of holders) {
      try {
        await chain.submit({ kind: 'burnRetired', seriesId, holder }, 'keeper');
        burned++;
      } catch (e) {
        if (!(e instanceof ChainError) || (e.code !== 'NotFound' && e.code !== 'WrongStatus')) throw e;
        refused++;
      }
    }
    if (holders.length) await audit(this.ctx.pool, { actor: by, actorRole: 'admin', action: 'retirement.burn-retired', target: seriesId, detail: { holders: holders.length, burned, refused } });
    return { burned, refused };
  }
}

/**
 * The redemption a tail or final claim runs first for a holder that still has units to redeem (Stage 1's
 * `claimRedemptionBody`): `units` redeemed and burned, `amount` the redemption price on them and their tail catch-up
 * (`redemptionClaimable`), `payout` the holder's pending payout (`claimable`), which the redemption pays too.
 */
export interface RedeemsFirst {
  units: string;
  amount: string;
  payout: string;
}
function redemptionPreview(p: PositionState, units: bigint): RedeemsFirst {
  return { units: units.toString(), amount: p.redemptionClaimable, payout: p.claimable };
}
function redeemsTotal(r: RedeemsFirst | null): bigint {
  return r ? BigInt(r.amount) + BigInt(r.payout) : 0n;
}

/** The claims of Stage 1's family that would pay the holder something now, in the family's order. */
export function claimsThatPay(p: Pick<PositionState, 'claimable' | 'redemptionClaimable' | 'tailClaimable' | 'finalClaimable'>): ('claimPayout' | 'claimRedemption' | 'claimTail' | 'claimFinal')[] {
  return [
    ...(BigInt(p.claimable) > 0n ? (['claimPayout'] as const) : []),
    ...(BigInt(p.redemptionClaimable) > 0n ? (['claimRedemption'] as const) : []),
    ...(BigInt(p.tailClaimable) > 0n ? (['claimTail'] as const) : []),
    ...(BigInt(p.finalClaimable) > 0n ? (['claimFinal'] as const) : []),
  ];
}
/**
 * A builder's 409 for a claim that would pay 0 and burn nothing: `reason` `nothing-to-claim` and `claimWith`, the other
 * claims that would pay the holder something now (the claim itself is never listed).
 */
function nothingToClaim(what: string, p: PositionState, self: ReturnType<typeof claimsThatPay>[number]): AppError {
  const claimWith = claimsThatPay(p).filter((c) => c !== self);
  return AppError.conflict(claimWith.length ? `nothing to claim as ${what}; claim with ${claimWith.join(', ')}` : 'nothing to claim', { reason: 'nothing-to-claim', claimWith });
}

/**
 * The units a holder holds in its own balance (Stage 1 `unitsOf`): its units less the auction units not yet delivered
 * and those held for a window ask. What a Retired claim or `burnRetired` burns.
 */
export function heldUnits(p: Pick<PositionState, 'units' | 'undeliveredUnits' | 'escrowedUnits'>): bigint {
  return BigInt(p.units) - BigInt(p.undeliveredUnits) - BigInt(p.escrowedUnits);
}

/**
 * Stage 1's `redeem` refusals that a quote can see (SIM:1335-1342), in Stage 1's order: the terminal and Late checks on
 * the derived status (Paused may redeem), the lockup, an unpaid due, an unpaid true-up, and an ended period without an
 * accepted report. Human text and the Stage 1 error names side by side.
 */
export function redeemBlockers(s: SeriesState, now: number): { blockers: string[]; blockedBy: ErrorName[] } {
  const blockers: string[] = [];
  const blockedBy: ErrorName[] = [];
  const add = (name: ErrorName, text: string) => {
    blockedBy.push(name);
    blockers.push(text);
  };
  if (isTerminal(SeriesStatus[s.status as keyof typeof SeriesStatus])) add('TerminalStatus', `status is ${s.status}`);
  if (s.status === 'Late') add('SeriesLate', 'status is Late: a late series cannot redeem');
  if (s.lockupEndsAt !== null && now < s.lockupEndsAt) add('LockupActive', `lockup ends at ${s.lockupEndsAt}`);
  const rep = s.reporting;
  if (BigInt(rep.openDueAmount) > 0n) add('PaymentOutstanding', `period ${rep.openDuePeriod} is reported and not paid`);
  if (rep.firstPeriod !== null) {
    const lastEnded = pidAt(BigInt(now)) - 1;
    const lastAccepted = rep.lastAcceptedPeriod === null ? null : toPid(rep.lastAcceptedPeriod);
    if (!(lastEnded < toPid(rep.firstPeriod) || (lastAccepted !== null && lastAccepted >= lastEnded))) add('UnreportedPeriods', `every ended period must be reported first: ${rep.nextExpectedPeriod} through ${fromPid(lastEnded)}`);
  }
  return { blockers, blockedBy };
}

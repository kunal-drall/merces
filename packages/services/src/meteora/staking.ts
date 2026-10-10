import { AppError } from '@merces/core';
import type { ChainPort, CurveState, PositionState, SeriesState, UnsignedTx } from '@merces/domain';
import { scaledAmount, walletTenderFits } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { censusLockedBy } from '../curve-census.ts';

/**
 * Curve staking as a first-class flow on the read and build side (S3 WP12, amendments M4 and M8; Stage 1 curve mode,
 * Solana curve.rs:1250-1528). On a curve series only staked units earn: these builders take a holder from units in its
 * wallet to a stake, back out (unstaking pays in the product: one transaction of `unstakeUnits` and `claimPayout`), and
 * to a tender at a redemption, and the wallet read says where each linked wallet stands. All on the `account` tier with
 * the wallet linked to the caller: a curve buyer has no position row (no holder access) until it stakes.
 *
 * Every refusal comes before the wallet signs, in Stage 1's in-handler order, with the Stage 1 name in `detail.stage1`
 * (a short wallet is the token program's refusal: `detail.code` InsufficientFunds, no Stage 1 name). Refusals and reads
 * name unit counts (public onchain balances), never an income figure.
 */

const TERMINAL = new Set(['Retired', 'Redeemed', 'Extinguished']);

/** Stage 1's names for what keeps a wallet from staking now, in `stake_units`' order (curve.rs:1257-1279). */
export type StakeBlocker = 'RaiseNotOpen' | 'TerminalStatus' | 'ZeroUnits' | 'NotAllowlisted' | 'StakeExceedsOutstanding';

/** A step a builder puts before the holder's own command: the permissionless registration or census, signed by the wallet. */
export type CurveStep = 'registerHolder' | 'syncCurveUnits' | 'stakeUnits';

/**
 * A linked wallet's curve position (amendment M8): its units in the wallet and in the stake vault, whether it earns,
 * what it can stake now and what stops it, what it can unstake, its pending payout, and its tender at a redemption.
 */
export interface CurveWalletPosition {
  wallet: string;
  /** on the chain's allowlist now (registration and staking need it; unstake, claims and tender do not) */
  approved: boolean;
  /** a registered holder of the series (Stage 1 holder record) */
  registered: boolean;
  /** base lamports of the unit mint in the wallet: they earn nothing until staked */
  walletUnits: string;
  /** base lamports in the stake vault for this holder: the only units that earn */
  stakedUnits: string;
  /** the wallet's stake earns (registered with units staked) */
  earning: boolean;
  /** payouts settled into the holder record and not claimed yet (an unstake through another tool leaves its credit here) */
  pending: string;
  /** what `claimPayout` pays now: `pending` plus what the stake earned since the holder's cursor */
  claimable: string;
  /**
   * the base lamports the stake builder can stake now (its registration and census steps included): the wallet's units,
   * at most what a census now leaves above the stakes; "0" when `stakeBlockedBy` names why
   */
  stakable: string;
  /** Stage 1's name for what stops a stake now (the first in `stake_units`' order); null when `stakable` is above 0 */
  stakeBlockedBy: StakeBlocker | null;
  /** why a census cannot be taken now when it would be needed: the issuer's assembled, unsubmitted report (amendment H1) */
  censusHeldBy: { periodId: string } | null;
  /** the steps the stake builder puts before `stakeUnits` for `stakable` */
  stakeSteps: CurveStep[];
  /** what the unstake builder can take back: the whole stake, never blocked (no allowlist or status check) */
  unstakable: string;
  /** the tender at a redemption; null before the series redeemed */
  tender: null | {
    /** the stake, always reserved for its holder */
    fromStake: string;
    /** the wallet units that fit what is left of the quota */
    fromWallet: string;
    /** what is left of the wallet units' quota: units at redemption − tendered − staked */
    quotaLeft: string;
    /** the redemption price per whole unit */
    pricePerUnit: string;
    /** what tendering `fromStake + fromWallet` pays as principal, `floor(P × units / 10^6)` (the pending payout comes on top) */
    principal: string;
    /** HolderNotRegistered for a wallet that never registered (registering needs the allowlist); null otherwise */
    blockedBy: 'HolderNotRegistered' | null;
  };
  /** the wallet's next step, as the keepers' reminders name it: approve-wallet, register-and-stake, stake, register-and-tender, tender, claim; null for none */
  next: string | null;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const conflict = (stage1: string, message: string, extra: Record<string, unknown> = {}): AppError => AppError.conflict(message, { stage1, ...extra });

/** The units in the wallet and in the stake (`getPosition` reads a buyer that never registered as unregistered). */
function unitsOf(p: PositionState | null): { walletUnits: bigint; staked: bigint } {
  return { walletUnits: BigInt(p?.walletUnits ?? '0'), staked: BigInt(p?.stakedUnits ?? '0') };
}

/** What is left of the wallet units' tender quota (Stage 1 `wallet_tender_fits`: staked units are reserved). */
function tenderQuotaLeft(series: SeriesState): bigint {
  const r = series.redemption;
  if (!r) return 0n;
  const left = BigInt(r.unitsAtRedemption) - BigInt(series.tenderedTotal) - BigInt(series.stakedTotal);
  return left > 0n ? left : 0n;
}

export class CurveStakingService {
  constructor(private readonly ctx: ServiceContext) {}

  private async curveSeries(seriesId: string): Promise<{ chain: ChainPort; series: SeriesState; curve: CurveState }> {
    const chain = this.ctx.chainFor(seriesId);
    if (chain.family !== 'solana') throw AppError.unprocessable('curve-mode raises exist on Solana only');
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    const curve = series.terms.raiseStyle === 'curve' ? await chain.getCurve(seriesId) : null;
    if (!curve) throw AppError.conflict('not a curve-mode series', { stage1: 'NotCurveMode' });
    return { chain, series, curve };
  }
  private requireWallet(session: Session, chain: string, address: string): void {
    if (!session.wallets.some((w) => w.chain === chain && w.address === address) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
  }

  /**
   * What a stake of up to `want` base lamports needs now (Stage 1 `stake_units`, curve.rs:1257-1279): the first blocker
   * in Stage 1's order, else how much can be staked and the steps before it. A wallet that is not registered gets the
   * registration first (permissionless; it needs the allowlist, checked before). A stake the last census cannot cover
   * gets a census first when a census now covers it, except while the issuer has an assembled, unsubmitted report for
   * the next expected period (amendment H1: its proof binds the current census).
   */
  private async stakePlan(series: SeriesState, curve: CurveState, p: PositionState | null, approved: boolean, want: bigint): Promise<{ blockedBy: StakeBlocker | null; units: bigint; steps: CurveStep[]; censusHeldBy: { periodId: string } | null }> {
    const none = (blockedBy: StakeBlocker, censusHeldBy: { periodId: string } | null = null) => ({ blockedBy, units: 0n, steps: [], censusHeldBy });
    if (series.phase !== 'Open' && series.phase !== 'Settled') return none('RaiseNotOpen');
    if (TERMINAL.has(series.status)) return none('TerminalStatus');
    if (want === 0n) return none('ZeroUnits');
    if (!approved) return none('NotAllowlisted');
    const staked = BigInt(series.stakedTotal);
    const stored = BigInt(series.unitsOutstanding);
    const roomStored = stored > staked ? stored - staked : 0n;
    const steps: CurveStep[] = p?.registered ? [] : ['registerHolder'];
    if (want <= roomStored) return { blockedBy: null, units: want, steps, censusHeldBy: null };
    // the last census does not cover it: a census now would count `curve.census.unitsOutstanding`
    const now = BigInt(curve.census.unitsOutstanding);
    const roomNow = now > staked ? now - staked : 0n;
    if (roomNow > roomStored) {
      const locked = await censusLockedBy(this.ctx, series);
      if (locked) return roomStored > 0n ? { blockedBy: null, units: roomStored, steps, censusHeldBy: { periodId: locked.periodId } } : none('StakeExceedsOutstanding', { periodId: locked.periodId });
      return { blockedBy: null, units: min(want, roomNow), steps: [...steps, 'syncCurveUnits'], censusHeldBy: null };
    }
    return roomStored > 0n ? { blockedBy: null, units: roomStored, steps, censusHeldBy: null } : none('StakeExceedsOutstanding');
  }

  /**
   * The caller's curve position on the series (amendment M8; account tier): one row per linked wallet on the series'
   * chain, or the one `wallet` names (it must be linked). Read live from the chain: a wallet that bought and never
   * registered or staked reads too, with its units and why it does not earn.
   */
  async walletPositions(seriesId: string, session: Session, wallet?: string): Promise<{ seriesId: string; unitScale: string; status: string; phase: string; redeemed: boolean; positions: CurveWalletPosition[] }> {
    const { chain, series, curve } = await this.curveSeries(seriesId);
    if (wallet) this.requireWallet(session, chain.chain, wallet);
    const wallets = wallet ? [wallet] : session.wallets.filter((w) => w.chain === chain.chain).map((w) => w.address);
    const positions: CurveWalletPosition[] = [];
    for (const w of wallets) {
      const p = await chain.getPosition(seriesId, w);
      const approved = await chain.isAllowlisted(w);
      const { walletUnits, staked } = unitsOf(p);
      const plan = await this.stakePlan(series, curve, p, approved, walletUnits);
      const registered = p?.registered ?? false;
      const r = series.redemption;
      let tender: CurveWalletPosition['tender'] = null;
      if (r) {
        const quotaLeft = tenderQuotaLeft(series);
        const fromWallet = min(walletUnits, quotaLeft);
        tender = {
          fromStake: staked.toString(), fromWallet: fromWallet.toString(), quotaLeft: quotaLeft.toString(), pricePerUnit: r.pricePerUnit,
          principal: scaledAmount(BigInt(r.pricePerUnit), staked + fromWallet, BigInt(series.unitScale)).toString(), blockedBy: registered ? null : 'HolderNotRegistered',
        };
      }
      const claimable = BigInt(p?.claimable ?? '0');
      const tenderable = tender !== null && BigInt(tender.fromStake) + BigInt(tender.fromWallet) > 0n;
      let next: string | null = null;
      if (tenderable) next = registered ? 'tender' : approved ? 'register-and-tender' : 'approve-wallet';
      else if (plan.units > 0n) next = registered ? 'stake' : 'register-and-stake';
      else if (plan.blockedBy === 'NotAllowlisted' && walletUnits > 0n) next = 'approve-wallet';
      else if (claimable > 0n) next = 'claim';
      positions.push({
        wallet: w, approved, registered, walletUnits: walletUnits.toString(), stakedUnits: staked.toString(), earning: registered && staked > 0n,
        pending: p?.pending ?? '0', claimable: claimable.toString(),
        stakable: plan.units.toString(), stakeBlockedBy: plan.blockedBy, censusHeldBy: plan.censusHeldBy, stakeSteps: plan.units > 0n ? plan.steps : [],
        unstakable: staked.toString(), tender, next,
      });
    }
    return { seriesId, unitScale: series.unitScale, status: series.status, phase: series.phase, redeemed: series.redemption !== null, positions };
  }

  /**
   * Stake `units` base lamports from `wallet` (Stage 1 `stake_units`): ordered unsigned steps to sign in turn, the
   * registration (`registerHolder`) when the wallet is not a registered holder, the census (`syncCurveUnits`) when the
   * last one cannot cover the stake and one now can, then `stakeUnits`. Refusals in Stage 1's order: 409 RaiseNotOpen,
   * 409 TerminalStatus, 409 ZeroUnits, 403 NotAllowlisted, 409 StakeExceedsOutstanding (a census now would not cover it
   * either, or the census is held by the issuer's assembled report: `detail.reason` `report-pending`; amendment H1;
   * `detail.stakable` what can be staked now), 409 InsufficientFunds (`detail.code`: the wallet holds fewer units). The
   * stake earns from the next payment.
   */
  async buildStake(seriesId: string, session: Session, wallet: string, unitsText: string): Promise<{ seriesId: string; wallet: string; units: string; steps: { step: CurveStep; tx: UnsignedTx }[]; stakedAfter: string }> {
    const { chain, series, curve } = await this.curveSeries(seriesId);
    this.requireWallet(session, chain.chain, wallet);
    const units = BigInt(unitsText);
    const approved = await chain.isAllowlisted(wallet);
    const p = await chain.getPosition(seriesId, wallet);
    const plan = await this.stakePlan(series, curve, p, approved, units);
    if (plan.blockedBy === 'RaiseNotOpen') throw conflict('RaiseNotOpen', `the raise is ${series.phase}`);
    if (plan.blockedBy === 'TerminalStatus') throw conflict('TerminalStatus', `the series is ${series.status}: stakes are closed`);
    if (plan.blockedBy === 'ZeroUnits') throw conflict('ZeroUnits', 'stake at least one base unit');
    if (plan.blockedBy === 'NotAllowlisted') throw AppError.forbidden('the wallet is not on the allowlist: only an approved wallet can register and stake (it can still sell its units)', { stage1: 'NotAllowlisted' });
    if (plan.blockedBy === 'StakeExceedsOutstanding' || plan.units < units) {
      const held = plan.censusHeldBy;
      throw conflict('StakeExceedsOutstanding', held
        ? `the stakes would pass the units the last census counted, and no census can be taken while the issuer's assembled ${held.periodId} report waits to be submitted (its proof binds the current census)`
        : 'the stakes would pass the units outstanding, even after a census now', { stakable: plan.units.toString(), ...(held ? { reason: 'report-pending', periodId: held.periodId } : {}) });
    }
    // Stage 1 settles the holder (the registration step covers it) and then moves the units: a short wallet comes last
    const { walletUnits, staked } = unitsOf(p);
    if (walletUnits < units) throw AppError.conflict('the wallet holds fewer units than that', { code: 'InsufficientFunds', walletUnits: walletUnits.toString() });
    const steps: { step: CurveStep; tx: UnsignedTx }[] = [];
    for (const step of plan.steps) {
      const cmd = step === 'registerHolder' ? { kind: 'registerHolder' as const, seriesId, wallet } : { kind: 'syncCurveUnits' as const, seriesId };
      steps.push({ step, tx: await chain.build(cmd, wallet) });
    }
    steps.push({ step: 'stakeUnits', tx: await chain.build({ kind: 'stakeUnits', seriesId, units: units.toString() }, wallet) });
    return { seriesId, wallet, units: units.toString(), steps, stakedAfter: (staked + units).toString() };
  }

  /**
   * Unstake `units` base lamports to `wallet` and claim in ONE transaction (owner direction of 2026-10-10; S3 decision
   * 1): `[unstakeUnits, claimPayout]`, all or nothing. Stage 1's `unstake_units` credits what the stake earned into the
   * holder's pending payout and moves no stablecoin; the bundled `claimPayout` pays exactly that pending payout, so
   * unstaking pays in the product. (A holder that unstakes through another tool without claiming keeps the credit as
   * `pending`: `claim` pays it later for any registered holder, holder records are never closed.) Never refused but
   * for 409 ZeroUnits or InsufficientStake (more than the stake): no allowlist and no status check (Stage 1).
   * `payout` is what the claim pays at the chain's current state.
   */
  async buildUnstake(seriesId: string, session: Session, wallet: string, unitsText: string): Promise<{ seriesId: string; wallet: string; units: string; tx: UnsignedTx; commands: string[]; payout: string; stakedAfter: string }> {
    const { chain } = await this.curveSeries(seriesId);
    this.requireWallet(session, chain.chain, wallet);
    const units = BigInt(unitsText);
    if (units === 0n) throw conflict('ZeroUnits', 'unstake at least one base unit');
    const p = await chain.getPosition(seriesId, wallet);
    const { staked } = unitsOf(p);
    if (units > staked) throw conflict('InsufficientStake', 'more units than the wallet has staked', { stakedUnits: staked.toString() });
    const tx = await chain.build([{ kind: 'unstakeUnits', seriesId, units: units.toString() }, { kind: 'claimPayout', seriesId }], wallet);
    return { seriesId, wallet, units: units.toString(), tx, commands: ['unstakeUnits', 'claimPayout'], payout: p?.claimable ?? '0', stakedAfter: (staked - units).toString() };
  }

  /**
   * Tender at a curve redemption (Stage 1 `tender_units`, curve.rs:1426-1528): `fromStake` staked and `fromWallet` wallet
   * base lamports burn, and the holder is paid `floor(P × units / 10^6)` (`principal`) plus its pending payout
   * (`payout`), `total` both. Staked units are reserved; wallet units share what is left of the count taken at
   * redemption (`quotaLeft`, after this tender `quotaLeftAfter`). Refusals in Stage 1's order: 409 NotRedeemed, 409
   * ZeroUnits, 409 InsufficientStake, 409 TenderQuotaExhausted, 409 HolderNotRegistered (registering needs the
   * allowlist), 409 InsufficientFunds (`detail.code`). No allowlist check: a registered holder taken off the allowlist
   * still tenders.
   */
  async buildTender(seriesId: string, session: Session, wallet: string, fromStakeText: string, fromWalletText: string): Promise<Record<string, unknown>> {
    const { chain, series } = await this.curveSeries(seriesId);
    this.requireWallet(session, chain.chain, wallet);
    const r = series.redemption;
    if (!r) throw conflict('NotRedeemed', 'the series has not redeemed: there is nothing to tender for yet');
    const fromStake = BigInt(fromStakeText);
    const fromWallet = BigInt(fromWalletText);
    const units = fromStake + fromWallet;
    if (units === 0n) throw conflict('ZeroUnits', 'tender at least one base unit');
    const p = await chain.getPosition(seriesId, wallet);
    const { walletUnits, staked } = unitsOf(p);
    if (fromStake > staked) throw conflict('InsufficientStake', 'more units than the wallet has staked', { stakedUnits: staked.toString() });
    const quotaLeft = tenderQuotaLeft(series);
    if (!walletTenderFits(BigInt(r.unitsAtRedemption), BigInt(series.tenderedTotal), BigInt(series.stakedTotal), fromWallet)) {
      throw conflict('TenderQuotaExhausted', 'the wallet units would pass what is left of the units counted at redemption (staked units are reserved)', { quotaLeft: quotaLeft.toString() });
    }
    if (!p?.registered) throw conflict('HolderNotRegistered', 'only a registered holder can tender: register the wallet first (registration needs an approved wallet)');
    if (walletUnits < fromWallet) throw AppError.conflict('the wallet holds fewer units than that', { code: 'InsufficientFunds', walletUnits: walletUnits.toString() });
    const principal = scaledAmount(BigInt(r.pricePerUnit), units, BigInt(series.unitScale));
    const payout = BigInt(p.claimable);
    const tx = await chain.build({ kind: 'tenderUnits', seriesId, fromStake: fromStake.toString(), fromWallet: fromWallet.toString() }, wallet);
    return {
      seriesId, wallet, tx, fromStake: fromStake.toString(), fromWallet: fromWallet.toString(), units: units.toString(), pricePerUnit: r.pricePerUnit,
      principal: principal.toString(), payout: payout.toString(), total: (principal + payout).toString(), quotaLeft: quotaLeft.toString(), quotaLeftAfter: (quotaLeft - fromWallet).toString(),
    };
  }
}

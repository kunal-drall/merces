import type { RaiseStateName } from '@merces/domain';
import type { AuctionExpect, HolderExpect, LedgerExpect } from '@merces/math';
import { WAD, nextExpectedPeriod } from '@merces/math';
import type { SimSeries } from './state.ts';
import { heldUnits } from './engine/holders.ts';
import { derivedStatus, ledgerClock, liveCapPerUnit, mintFinalized } from './engine/ledger.ts';
import { windowEscrow } from './reads/window.ts';

/**
 * Stage 1's view of one series, built from the simulator state: the shapes of the Stage 1 vector `expect` step
 * (Stage 1 simulator `ledgerExpect`, `auctionExpect` and `expect`, SIM:1664-1800). The vector runner compares them
 * with the vectors; white-box tests read them through `SimulatorChain.stage1View`. Values are decimal strings, as in
 * the vectors. Nothing here is part of ChainPort. Every field comes from the engine's own state, each from a single
 * source (the auction view and the holders' pending fields since S2 WP4a: the engine runs Stage 1's settlement).
 */

const D = (v: bigint | number): string => v.toString();
const P = (p: number | null): string | null => (p === null ? null : D(p));

/** Stage 1's `mintFinalized`: defined with the ledger (`engine/ledger.ts`), shared by the engine and these views. */
export { mintFinalized };

/**
 * Stablecoin held by the auction escrow (Stage 1 `escrowTotal`): the deposits, less each processed bid's cost and fee,
 * less the refunds delivered. The ledger, money and auction views share it.
 */
export function auctionEscrow(s: SimSeries): bigint {
  return s.auction.escrowTotal;
}

/**
 * A bidder's refund still held by the auction escrow (Stage 1's `pendingRefund` of a processed, undelivered bid),
 * else 0. The engine's own figure: the non-reveal charge already taken when an unrevealed bid was processed.
 */
export function pendingRefundOf(s: SimSeries, wallet: string): bigint {
  const b = s.bids.get(wallet);
  return b && b.processed && !b.delivered ? b.pendingRefund : 0n;
}

/**
 * The units `wallet`'s Stage 1 account holds of the series (`unitsOf`): its position less the units held for a window
 * ask and the auction units not yet delivered (`heldUnits`).
 */
export function balanceUnits(s: SimSeries, wallet: string): bigint {
  const p = s.positions.get(wallet);
  return p ? heldUnits(s, p) : 0n;
}

/**
 * Stage 1's next expected report period for a settled series (`nextExpectedPeriod` over its ledger clock, SPEC §6.4):
 * the period the vector runner's `pay` shim falls back to when nothing is due.
 */
export function nextExpectedPid(s: SimSeries): number {
  return nextExpectedPeriod(ledgerClock(s));
}

/** Stage 1 `RaiseState` name: the stored raise state (the reveal phase is time-derived; Stage 1 keeps the raise Open). */
export function raiseStateName(s: SimSeries): RaiseStateName {
  return s.phase;
}

/** Stage 1's ledger view (SIM:1664-1709), keys in Stage 1's order. `status` is the status derived at `now`. */
export function ledgerView(s: SimSeries, now: number): LedgerExpect {
  const l = s.ledger;
  const v = s.vault;
  return {
    status: derivedStatus(s, now),
    raiseState: raiseStateName(s),
    mintFinalized: mintFinalized(s),
    unitsOutstanding: D(s.unitsOutstanding),
    // the auction's results (a failed raise keeps its price and would-be units); a curve's own
    unitsSold: D(s.curve ? s.unitsSold : s.auction.unitsSold),
    clearingPrice: D(s.curve ? s.issuePrice ?? 0n : s.auction.clearingPrice ?? 0n),
    proceeds: D(s.treasuryTotal),
    releasedTotal: D(s.treasuryReleased),
    capPerUnit: D(s.phase === 'Settled' ? liveCapPerUnit(s) : 0n),
    capMultipleWad: D(s.terms.capMultipleWad),
    termsCommitment: s.terms.termsCommitment.toLowerCase(),
    amendmentNonce: D(l.amendmentNonce),
    paidPerUnitWad: D(v.paidPerUnitWad),
    netAccWad: D(v.netAccWad),
    carryWad: D(v.carryWad),
    carry: D(v.carryWad / WAD),
    grossReceived: D(v.grossReceived),
    feeCollected: D(v.feeCollected),
    refundedToIssuer: D(v.refundedToIssuer),
    lastAcceptedPeriod: P(l.lastAcceptedPeriod),
    lastPaidPeriod: P(l.lastPaidPeriod),
    openDuePeriod: P(l.openDuePeriod),
    openDueAmount: D(l.openDueAmount),
    routerCredit: D(l.routerCredit),
    trueupNonce: D(l.trueupNonce),
    trueupDue: D(l.trueupDue),
    trueupAttestedAt: D(l.trueupAttestedAt),
    lastTrueupYear: P(l.lastTrueupYear),
    pauseNonce: D(l.pauseNonce),
    pauseCount: D(l.pauses.length),
    pausedTotal: D(l.pausedTotal),
    formalNoticeEmittedFor: P(l.formalNoticeEmittedFor),
    redemptionPrice: D(s.redemption?.pricePerUnit ?? 0n),
    unitsAtRedemption: D(s.redemption?.unitsAtRedemption ?? 0n),
    tailCapPerUnit: D(s.tail.tailCapPerUnit),
    tailAccWad: D(s.tail.tailAccWad),
    tailExhausted: s.tail.tailExhausted,
    extinguishedAt: D(s.extinguishedAt ?? 0),
    finalAccWad: D(s.final.finalAccWad),
    finalUnits: D(s.final.finalUnits),
    extinguishNonce: D(l.extinguishNonce),
  };
}

/** Stage 1's auction view (SIM:1711-1731), keys in Stage 1's order. */
export function auctionEngineView(s: SimSeries): AuctionExpect {
  const a = s.auction;
  return {
    bidCount: D(s.bids.size),
    revealedCount: D(a.revealedCount),
    validCount: D(a.validCount),
    escrowTotal: D(a.escrowTotal),
    auctionEscrowUnits: D(a.escrowUnits),
    tallyRound: D(a.tallyRound),
    roundRejected: a.roundRejected,
    rejectionReason: a.rejectionReason,
    clearingPrice: D(a.clearingPrice ?? 0n),
    qAbove: D(a.qAbove),
    qAt: D(a.qAt),
    R: D(a.R),
    unitsSold: D(a.unitsSold),
    proceeds: D(a.proceeds),
    unitsMinted: D(a.unitsMinted),
    bidsProcessed: D(a.bidsProcessed),
    mintFinalized: a.mintFinalized,
  };
}

/** The series' money pools as the vector `expect` names them (SIM:1771-1781); window escrows only once a window exists. */
export interface MoneyView {
  treasury: string;
  vault: string;
  auctionEscrow: string;
  windowEscrowStable?: string;
  windowEscrowUnits?: string;
}

export function moneyView(s: SimSeries): MoneyView {
  const out: MoneyView = {
    treasury: D(s.treasuryTotal - s.treasuryReleased - s.treasuryReturned),
    vault: D(s.vaultBalance),
    auctionEscrow: D(auctionEscrow(s)),
  };
  const w = s.transferWindows.at(-1);
  if (w) {
    const escrow = windowEscrow(w);
    out.windowEscrowStable = D(escrow.stable);
    out.windowEscrowUnits = D(escrow.units);
  }
  return out;
}

/**
 * Registered holders only, by wallet in Stage 1's sort order (SIM:1785-1797): the **stored** `pending` (no live
 * settlement), the redeemed units, and the holder's auction bid: what it is still owed (processed, not delivered) and
 * whether it was delivered (`true` for a holder without a bid).
 */
export function holdersView(s: SimSeries): Record<string, HolderExpect> {
  const out: Record<string, HolderExpect> = {};
  const registered = [...s.positions.values()].filter((p) => p.registered).sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  for (const p of registered) {
    const bid = s.bids.get(p.wallet);
    const owed = !!bid && bid.processed && !bid.delivered;
    out[p.wallet] = {
      pending: D(p.pending),
      redeemedUnits: D(p.redeemedUnits),
      pendingUnits: D(owed ? bid.pendingUnits : 0n),
      pendingRefund: D(owed ? bid.pendingRefund : 0n),
      delivered: bid ? bid.delivered : true,
    };
  }
  return out;
}

export interface Stage1View {
  ledger: LedgerExpect;
  auction: AuctionExpect;
  money: MoneyView;
  holders: Record<string, HolderExpect>;
}

export function stage1View(s: SimSeries, now: number): Stage1View {
  return { ledger: ledgerView(s, now), auction: auctionEngineView(s), money: moneyView(s), holders: holdersView(s) };
}

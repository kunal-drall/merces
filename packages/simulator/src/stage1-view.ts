import type { AuctionExpect, HolderExpect, LedgerExpect } from '@merces/math';
import { WAD, nextExpectedPeriod } from '@merces/math';
import type { SimSeries } from './state.ts';
import { derivedStatus, ledgerClock, liveCapPerUnit, mintFinalized } from './engine/ledger.ts';
import { windowEscrow } from './reads/window.ts';

/**
 * Stage 1's view of one series, built from the simulator state: the shapes of the Stage 1 vector `expect` step
 * (Stage 1 simulator `ledgerExpect`, `auctionExpect` and `expect`, SIM:1664-1800). The vector runner compares them
 * with the vectors; white-box tests read them through `SimulatorChain.stage1View`. Values are decimal strings, as in
 * the vectors. Nothing here is part of ChainPort.
 *
 * Where our one-step raise has no counterpart for an auction field (tally rounds, processed bids, undelivered units),
 * the runner keeps its own bookkeeping; the fields below are the ones the engine owns, each from a single source.
 */

const D = (v: bigint | number): string => v.toString();
const P = (p: number | null): string | null => (p === null ? null : D(p));

/** Stage 1's `mintFinalized`: defined with the ledger (`engine/ledger.ts`), shared by the engine and these views. */
export { mintFinalized };

/**
 * Stablecoin held by the auction escrow (Stage 1 `escrowTotal`): every deposit until its bid is settled, then the
 * refund still unclaimed (`refundable`, which `claimRefund` zeroes). The ledger, money and auction views share it.
 */
export function auctionEscrow(s: SimSeries): bigint {
  let total = 0n;
  for (const b of s.bids.values()) total += b.settled ? b.refundable : b.deposit;
  return total;
}

/**
 * A bidder's refund still held by the auction escrow (the source of the runner's `pendingRefund`): the engine's
 * `refundable` once the bid is settled, else 0. Never Stage 1's `processBid`, which would apply the non-reveal
 * charge that S1 does not model.
 */
export function pendingRefundOf(s: SimSeries, wallet: string): bigint {
  const b = s.bids.get(wallet);
  return b && b.settled ? b.refundable : 0n;
}

/**
 * Stage 1's next expected report period for a settled series (`nextExpectedPeriod` over its ledger clock, SPEC §6.4):
 * the period the vector runner's `pay` shim falls back to when nothing is due.
 */
export function nextExpectedPid(s: SimSeries): number {
  return nextExpectedPeriod(ledgerClock(s));
}

/** Stage 1 `RaiseState` name for our raise phase (the reveal phase is time-derived; Stage 1 keeps the raise Open). */
export function raiseStateName(s: SimSeries): 'Draft' | 'Open' | 'Settled' | 'Failed' | 'Cancelled' {
  return s.phase === 'Reveal' ? 'Open' : s.phase;
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
    unitsSold: D(s.unitsSold),
    clearingPrice: D(s.issuePrice ?? 0n),
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

/** The auction fields the engine owns (SIM:1711-1732); the runner adds the multi-step fields from its bookkeeping. */
export type AuctionEngineView = Pick<AuctionExpect, 'bidCount' | 'revealedCount' | 'escrowTotal' | 'clearingPrice' | 'unitsSold' | 'proceeds' | 'mintFinalized'>;

export function auctionEngineView(s: SimSeries): AuctionEngineView {
  return {
    bidCount: D(s.bids.size),
    revealedCount: D([...s.bids.values()].filter((b) => b.revealed).length),
    escrowTotal: D(auctionEscrow(s)),
    clearingPrice: D(s.issuePrice ?? 0n),
    unitsSold: D(s.unitsSold),
    proceeds: D(s.treasuryTotal),
    mintFinalized: mintFinalized(s),
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

/** A registered holder's stored figures (SIM:1785-1797); the runner adds `pendingUnits`, `pendingRefund` and `delivered`. */
export type HolderView = Pick<HolderExpect, 'pending' | 'redeemedUnits'>;

/** Registered holders only, by wallet in Stage 1's sort order, with the **stored** `pending` (no live settlement). */
export function holdersView(s: SimSeries): Record<string, HolderView> {
  const out: Record<string, HolderView> = {};
  const registered = [...s.positions.values()].filter((p) => p.registered).sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  for (const p of registered) out[p.wallet] = { pending: D(p.pending), redeemedUnits: D(p.redeemedUnits) };
  return out;
}

export interface Stage1View {
  ledger: LedgerExpect;
  auction: AuctionEngineView;
  money: MoneyView;
  holders: Record<string, HolderView>;
}

export function stage1View(s: SimSeries, now: number): Stage1View {
  return { ledger: ledgerView(s, now), auction: auctionEngineView(s), money: moneyView(s), holders: holdersView(s) };
}

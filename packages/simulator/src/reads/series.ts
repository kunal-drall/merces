import type { IssuerState, SeriesState, UnitScale } from '@merces/domain';
import { nextExpectedPeriod } from '@merces/math';
import type { SimIssuer, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { derivedStatus, ledgerClock, liveCapPerUnit, mintFinalized, periodIdOf } from '../engine/ledger.ts';
import { releasesBlockedByLateness } from '../engine/status.ts';
import { toRedemption } from './redemption.ts';

const pid = (p: number | null): string | null => (p === null ? null : periodIdOf(p));

export function toIssuerState(i: SimIssuer): IssuerState {
  return { issuer: i.issuer, registeredAt: i.registeredAt, issuanceStopped: i.issuanceStopped, seriesIds: [...i.seriesIds] };
}
/**
 * The deprecated single-pause view (`SeriesState.pause`), from the ledger: the pending request's advisory end, and the
 * oldest recorded pause whose end has not been announced (`crankPause`) — the running pause, or one that ended and
 * waits for its `PauseEnded`. Null when neither exists. `pauses` is the Stage 1 view.
 */
function legacyPause(x: SimSeries): SeriesState['pause'] {
  const l = x.ledger;
  const unannounced = l.pauses[l.pauseEndedEmitted] ?? null;
  if (!l.pauseRequested && !unannounced) return null;
  return {
    requestedUntil: l.pauseRequested && l.pauseRequestedUntil !== null ? Number(l.pauseRequestedUntil) : null,
    approvedUntil: unannounced ? Number(unannounced.end) : null,
    startedAt: unannounced ? Number(unannounced.start) : null,
  };
}

/** `status` is the status derived at `now` (Stage 1 `deriveStatus`): a hardship pause ends on its own at its end. */
export function toSeriesState(chain: string, x: SimSeries, now: number): SeriesState {
  const t = x.terms;
  const l = x.ledger;
  const current = l.pauses.find((p) => p.start <= BigInt(now) && BigInt(now) < p.end) ?? null;
  return {
    seriesId: x.seriesId, chain, issuer: x.issuer, unitScale: s(x.unitScale) as UnitScale,
    terms: {
      stablecoin: t.stablecoin, stablecoinMint: t.stablecoinMint, unitsOffered: s(t.unitsOffered), reservePrice: s(t.reservePrice), minimumRaise: s(t.minimumRaise), capMultipleWad: s(t.capMultipleWad), lockupSeconds: t.lockupSeconds,
      releaseSchedule: t.releaseSchedule.map((r) => ({ ...r })), auctionFeeBps: Number(t.auctionFeeBps), payoutFeeBps: Number(t.payoutFeeBps), hurdleWad: s(t.hurdleWad), payoutMultipleK: Number(t.payoutMultipleK), walletCapBps: Number(t.walletCapBps),
      nonRevealChargeBps: t.nonRevealChargeBps, commitDurationSeconds: t.commitDurationSeconds, revealDurationSeconds: t.revealDurationSeconds,
      dueDays: t.dueDays, graceDays: t.graceDays, formalNoticeDays: t.formalNoticeDays, contractHash: t.contractHash, termsCommitment: t.termsCommitment, tierFlags: { ...t.tierFlags }, reportingCurrency: t.reportingCurrency, raiseStyle: t.raiseStyle,
    },
    phase: x.phase, status: derivedStatus(x, now), createdAt: x.createdAt, openedAt: x.openedAt, settledAt: x.settledAt, issuePrice: x.issuePrice === null ? null : s(x.issuePrice), unitsSold: s(x.unitsSold), unitsOutstanding: s(x.unitsOutstanding), unitsSyncedAt: x.unitsSyncedAt,
    stakedTotal: s(x.stakedTotal), tenderedTotal: s(x.tenderedTotal),
    capPerUnit: x.issuePrice === null ? null : s(liveCapPerUnit(x)), paidPerUnitWad: s(x.vault.paidPerUnitWad), accNetWad: s(x.vault.netAccWad), lockupEndsAt: x.settledAt === null ? null : x.settledAt + t.lockupSeconds,
    releasesPaused: x.releasesPausedByIssuer || releasesBlockedByLateness(x, now), releasesPausedByIssuer: x.releasesPausedByIssuer, pause: legacyPause(x), pausedSecondsTotal: Number(l.pausedTotal),
    redemption: x.redemption ? toRedemption(x) : null, extinguishedAt: x.extinguishedAt, grossPaidTotal: s(x.grossPaidTotal), feesTotal: s(x.feesTotal),
    reporting: {
      firstPeriod: pid(l.firstPeriod),
      nextExpectedPeriod: x.phase === 'Settled' && l.firstPeriod !== null ? periodIdOf(nextExpectedPeriod(ledgerClock(x))) : null,
      lastAcceptedPeriod: pid(l.lastAcceptedPeriod), lastPaidPeriod: pid(l.lastPaidPeriod), openDuePeriod: pid(l.openDuePeriod), openDueAmount: s(l.openDueAmount),
      lastIncomePeriod: pid(l.lastIncomePeriod), lastIncomeCommitment: l.lastIncomeCommitment,
    },
    pauses: {
      count: l.pauses.length, pausedTotalSeconds: Number(l.pausedTotal), nonce: Number(l.pauseNonce), requested: l.pauseRequested,
      requestedUntil: l.pauseRequestedUntil === null ? null : Number(l.pauseRequestedUntil), current: current ? { start: Number(current.start), end: Number(current.end) } : null,
    },
    formalNoticeEmittedFor: pid(l.formalNoticeEmittedFor), carryWad: s(x.vault.carryWad), refundedToIssuer: s(x.vault.refundedToIssuer),
    yearGross: x.vault.yearGross.map((y) => ({ year: y.year, grossWad: s(y.grossWad) })),
    final: { accWad: s(x.final.finalAccWad), units: s(x.final.finalUnits), distributed: s(x.final.unreleasedDistributed) },
    amendmentNonce: Number(l.amendmentNonce), extinguishNonce: Number(l.extinguishNonce), mintFinalized: mintFinalized(x),
  };
}

import type { IssuerState, SeriesState } from '@merces/domain';
import { nextExpectedPeriod } from '@merces/math';
import type { SimIssuer, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { ledgerClock, periodIdOf } from '../engine/ledger.ts';
import { toRedemption } from './redemption.ts';

const pid = (p: number | null): string | null => (p === null ? null : periodIdOf(p));

export function toIssuerState(i: SimIssuer): IssuerState {
  return { issuer: i.issuer, registeredAt: i.registeredAt, issuanceStopped: i.issuanceStopped, seriesIds: [...i.seriesIds] };
}
export function toSeriesState(chain: string, x: SimSeries, now: number): SeriesState {
  const t = x.terms;
  const l = x.ledger;
  const current = l.pauses.find((p) => p.start <= BigInt(now) && BigInt(now) < p.end) ?? null;
  return {
    seriesId: x.seriesId, chain, issuer: x.issuer,
    terms: {
      stablecoin: t.stablecoin, stablecoinMint: t.stablecoinMint, unitsOffered: s(t.unitsOffered), reservePrice: s(t.reservePrice), minimumRaise: s(t.minimumRaise), capMultipleWad: s(t.capMultipleWad), lockupSeconds: t.lockupSeconds,
      releaseSchedule: t.releaseSchedule.map((r) => ({ ...r })), auctionFeeBps: Number(t.auctionFeeBps), payoutFeeBps: Number(t.payoutFeeBps), hurdleWad: s(t.hurdleWad), payoutMultipleK: Number(t.payoutMultipleK), walletCapBps: Number(t.walletCapBps),
      dueDays: t.dueDays, graceDays: t.graceDays, formalNoticeDays: t.formalNoticeDays, contractHash: t.contractHash, termsCommitment: t.termsCommitment, tierFlags: { ...t.tierFlags }, reportingCurrency: t.reportingCurrency, raiseStyle: t.raiseStyle,
    },
    phase: x.phase, status: x.status, createdAt: x.createdAt, openedAt: x.openedAt, settledAt: x.settledAt, issuePrice: x.issuePrice === null ? null : s(x.issuePrice), unitsSold: s(x.unitsSold), unitsOutstanding: s(x.unitsOutstanding),
    capPerUnit: x.capPerUnit === null ? null : s(x.capPerUnit), paidPerUnitWad: s(x.paidPerUnitWad), accNetWad: s(x.accNetWad), lockupEndsAt: x.settledAt === null ? null : x.settledAt + t.lockupSeconds,
    releasesPaused: x.releasesPausedLate || x.releasesPausedByIssuer, releasesPausedByIssuer: x.releasesPausedByIssuer, pause: x.pause ? { ...x.pause } : null, pausedSecondsTotal: x.pausedSecondsTotal,
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
    amendmentNonce: Number(l.amendmentNonce), extinguishNonce: Number(l.extinguishNonce),
  };
}

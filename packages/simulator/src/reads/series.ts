import type { IssuerState, SeriesState } from '@merces/domain';
import type { SimIssuer, SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { toRedemption } from './redemption.ts';

export function toIssuerState(i: SimIssuer): IssuerState {
  return { issuer: i.issuer, registeredAt: i.registeredAt, issuanceStopped: i.issuanceStopped, seriesIds: [...i.seriesIds] };
}
export function toSeriesState(chain: string, x: SimSeries): SeriesState {
  const t = x.terms;
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
  };
}

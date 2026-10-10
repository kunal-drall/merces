import type { BidState } from '@merces/domain';

/**
 * Row → API shapes. Money stays a string; bigint columns arrive as strings from pg.
 *
 * The reporting-ledger fields (`nextExpectedPeriod`, `openDuePeriod`, `formalNoticeEmittedFor`, ...) come from the
 * indexer's projection of Stage 1's ledger (migration 017: AuctionSettled / CurveGraduated, ReportAccepted,
 * PaymentReceived, SeriesRetired, SeriesExtinguished, FormalNoticeDue), one source with the rest of the row, never a
 * live chain read
 * (critique M8). `status` is the status the chain last stored (its StatusChanged events). The open due's amount is a
 * payment amount, which PRIVACY.md gives to the issuer, holders and admins only: the public row says only whether a
 * due is open (`paymentOutstanding`); the amount is in `reportingRow` (served at the holder-or-issuer tier).
 */
export function seriesRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    seriesId: r.series_id,
    chain: r.chain,
    issuer: r.issuer,
    stablecoin: r.stablecoin,
    raiseStyle: r.raise_style,
    phase: r.phase,
    status: r.status,
    terms: {
      unitsOffered: r.units_offered,
      reservePrice: r.reserve_price,
      minimumRaise: r.minimum_raise,
      capMultipleWad: r.cap_multiple_wad,
      lockupSeconds: Number(r.lockup_seconds),
      releaseSchedule: r.release_schedule,
      auctionFeeBps: r.auction_fee_bps,
      payoutFeeBps: r.payout_fee_bps,
      hurdleWad: r.hurdle_wad,
      payoutMultipleK: r.payout_multiple_k,
      walletCapBps: r.wallet_cap_bps,
      dueDays: r.due_days,
      graceDays: r.grace_days,
      formalNoticeDays: r.formal_notice_days,
      contractHash: r.contract_hash,
      termsCommitment: r.terms_commitment,
      tierFlags: r.tier_flags,
      reportingCurrency: r.reporting_currency,
    },
    createdAt: Number(r.created_at),
    openedAt: r.opened_at === null ? null : Number(r.opened_at),
    commitEndsAt: r.commit_ends_at === null ? null : Number(r.commit_ends_at),
    revealEndsAt: r.reveal_ends_at === null ? null : Number(r.reveal_ends_at),
    settledAt: r.settled_at === null ? null : Number(r.settled_at),
    lockupEndsAt: r.lockup_ends_at === null ? null : Number(r.lockup_ends_at),
    issuePrice: r.issue_price,
    unitsSold: r.units_sold,
    unitsOutstanding: r.units_outstanding,
    capPerUnit: r.cap_per_unit,
    paidPerUnitWad: r.paid_per_unit_wad,
    releasesPaused: r.releases_paused,
    redeemedAt: r.redeemed_at === null ? null : Number(r.redeemed_at),
    extinguishedAt: r.extinguished_at === null ? null : Number(r.extinguished_at),
    firstPeriod: r.first_period ?? null,
    nextExpectedPeriod: r.next_expected_period ?? null,
    lastAcceptedPeriod: r.last_accepted_period ?? null,
    lastPaidPeriod: r.last_paid_period ?? null,
    openDuePeriod: r.open_due_period ?? null,
    paymentOutstanding: BigInt(String(r.open_due_amount ?? '0')) > 0n,
    formalNoticeEmittedFor: r.formal_notice_emitted_for ?? null,
  };
}

/**
 * Stage 1's reporting ledger of a series with the open due's amount (holder-or-issuer tier): the period a report may
 * be submitted for next, the period whose due is unpaid and that due as reported (before lateness accrual; the open
 * period's live `paymentDue` adds the accrual to date), and the period whose formal notice the chain recorded.
 */
export function reportingRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    firstPeriod: r.first_period ?? null,
    nextExpectedPeriod: r.next_expected_period ?? null,
    lastAcceptedPeriod: r.last_accepted_period ?? null,
    lastPaidPeriod: r.last_paid_period ?? null,
    openDuePeriod: r.open_due_period ?? null,
    openDueAmount: r.open_due_amount === null || r.open_due_amount === undefined ? '0' : String(r.open_due_amount),
    formalNoticeEmittedFor: r.formal_notice_emitted_for ?? null,
  };
}

/**
 * What claimRefund would pay a bidder right now: nothing before settlement; afterwards the deposit less the
 * allocated units at the issue price, the auction fee on that spend, and anything already refunded. Mirrors the
 * chain's settlement arithmetic so read routes and the refund builder agree.
 */
export function bidRefundable(bid: Pick<BidState, 'deposit' | 'refunded' | 'revealed' | 'allocatedUnits' | 'settled'>, series: { issuePrice: string | null; terms: { auctionFeeBps: number | string } }): bigint {
  if (!bid.settled) return 0n;
  const spent = bid.revealed && BigInt(bid.allocatedUnits) > 0n ? BigInt(bid.allocatedUnits) * BigInt(series.issuePrice ?? '0') : 0n;
  const fee = (spent * BigInt(series.terms.auctionFeeBps)) / 10_000n;
  const r = BigInt(bid.deposit) - spent - fee - BigInt(bid.refunded);
  return r > 0n ? r : 0n;
}

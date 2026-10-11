import { CURVE_NO_CAP, unitScaleOf } from '@merces/domain';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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
 *
 * The auction's settlement (S2: the round, the results `finalizeSettlement` wrote, the mint gate) comes from the same
 * projection (migration 019) and is public onchain state, like the bids it settles.
 *
 * `unitScale` (S3) is derived from the raise style (`unitScaleOf`: 1 sealed, 10^6 base lamports per whole unit for a
 * curve), as Stage 1 fixes `unit_scale` at creation from the style; no column holds it. So is "no cap" (S3 WP7): a
 * curve series has no wallet cap at any stage (its `terms.walletCapBps` is Stage 1's 0), so the read says so itself,
 * `noCap: true` with the one statement (`CURVE_NO_CAP`), rather than leave a 0 to be read as a cap.
 */
export function seriesRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    seriesId: r.series_id,
    chain: r.chain,
    issuer: r.issuer,
    stablecoin: r.stablecoin,
    raiseStyle: r.raise_style,
    unitScale: unitScaleOf(r.raise_style as 'sealed' | 'curve').toString(),
    noCap: r.raise_style === 'curve',
    noCapStatement: r.raise_style === 'curve' ? CURVE_NO_CAP : null,
    phase: r.phase,
    status: r.status,
    terms: {
      fxPairId: r.fx_pair_id ?? null,
      ...(r.router_terms ? {routerTerms:r.router_terms} : {}),
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
      // the sealed raise's phases (Stage 1 create_series; null on rows indexed before S2) and the series' own non-reveal
      // charge, applied when its raise settles (Stage 1 process_bid; series created under the S2 hold record 0)
      commitDurationSeconds: num(r.commit_duration_seconds),
      revealDurationSeconds: num(r.reveal_duration_seconds),
      nonRevealChargeBps: num(r.non_reveal_charge_bps),
      windowCommitDuration: num(r.window_commit_duration), windowRevealDuration: num(r.window_reveal_duration), windowFeeBps: num(r.window_fee_bps),
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
    // curve staking as indexed (S3 WP12; base lamports): the stakes, the units tendered at the redemption and the time
    // of the last census (units outstanding is that census' count); "0", "0" and null on a sealed-bid series
    stakedTotal: String(r.staked_total ?? '0'),
    tenderedTotal: String(r.tendered_total ?? '0'),
    unitsSyncedAt: num(r.units_synced_at),
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
    // Stage 1's mint gate: the last bid of a sealed raise is processed, or a curve completed (completeCurve)
    mintFinalized: r.mint_finalized === true,
    auction: r.raise_style === 'sealed' ? auctionRow(r) : null,
  };
}

/**
 * A sealed raise's settlement as indexed (S2; public onchain state): the current round and whether it was rejected,
 * and what `finalizeSettlement` wrote. A failed raise keeps its price and its would-be units and proceeds here (with
 * `failureReason`); the series' `issuePrice` stays null. A NoValidBids failure found no price: `clearingPrice` is null
 * (the indexer records it so; the chains' RaiseFailed carries 0). `finalizedAt` is when the raise settled or failed.
 */
function auctionRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    round: Number(r.settlement_round ?? 0),
    roundRejected: r.round_rejected === true,
    rejectionReason: r.rejection_reason ?? null,
    clearingPrice: r.auction_clearing_price ?? null,
    unitsSold: String(r.auction_units_sold ?? '0'),
    proceeds: String(r.auction_proceeds ?? '0'),
    failureReason: r.auction_failure_reason ?? null,
    finalizedAt: num(r.auction_finalized_at),
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

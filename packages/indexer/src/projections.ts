import type { PoolClient } from '@merces/db';
import type { DomainEvent, EventPayload } from '@merces/domain';
import { DEFAULTS, unitScaleOf } from '@merces/domain';
import { capPerUnit, fromPid, pidAt, toPid } from '@merces/math';

type P<T extends DomainEvent['type']> = EventPayload<T>;

/** The Stage 1 period ("YYYYQn") containing a unix time, and the period after one (the reporting ledger, M8). */
const periodAt = (ts: number): string => fromPid(pidAt(BigInt(ts)));
const nextPeriod = (periodId: string): string => fromPid(toPid(periodId) + 1);

/** Public activity summaries. Never an amount (R28). Unit counts and statuses only. */
function summary(e: DomainEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'IssuerRegistered': return 'Issuer registered';
    case 'SeriesCreated': return 'Series created';
    case 'CurveActivated': return 'Curve opened: units are bought and sold on its bonding curve';
    // a curve's activation opens its raise with no commit or reveal phase (Stage 1 RaiseOpened{0, 0})
    case 'RaiseOpened': return p.commitEndsAt === 0 ? null : 'Raise opened for sealed bids';
    case 'RaiseCancelled': return 'Raise cancelled before any bids';
    case 'BidCommitted': return 'A sealed bid was committed';
    case 'BidRevealed': return 'A bid was revealed';
    case 'AuctionSettled': return `Auction settled: ${p.unitsSold} units sold`;
    case 'AuctionFailed': return `Auction failed (${p.reason}); deposits are returned to the bidders`;
    case 'SettlementProposed': return `Settlement proposed (round ${p.round})`;
    case 'SettlementRejected': return `Settlement round ${p.round} rejected (${p.reason})`;
    case 'UnitsAllocated': return `${p.units} units allocated to a bidder`;
    case 'BidDelivered': return 'A bid was delivered';
    case 'NonRevealCharged': return 'An unrevealed bid was charged the non-reveal charge';
    case 'RaiseMintFinalized': return 'Raise minting finalised';
    case 'FundsReleased': return `Treasury tranche ${p.trancheIndex} released to the issuer`;
    case 'ReleasesPaused': return `Treasury releases paused (${p.reason})`;
    case 'ReleasesResumed': return 'Treasury releases resumed';
    case 'ReportAccepted': return `Report accepted for ${p.periodId} (tier ${p.tier})`;
    case 'PaymentReceived': return `Payment received${p.periodId ? ` for ${p.periodId}` : ''}`;
    case 'PayoutClaimed': return 'A holder claimed a payout';
    case 'TailClaimed': return 'A holder claimed its tail payout';
    case 'FinalClaimed': return 'A holder claimed its final-pool share';
    case 'SeriesRetired': return 'Series reached its cap and retired';
    // a burn of 0 (`burnRetired` on a wallet holding nothing, which anyone may send) is not in the feed
    case 'UnitsBurned': return p.units === '0' ? null : `${p.units} units burned (${p.reason})`;
    case 'RedemptionOpened': return 'Issuer opened redemption';
    case 'RedemptionClaimed': return 'A holder claimed redemption';
    case 'TailPayout': return `Tail payout for ${p.periodId}`;
    case 'PauseRequested': return 'Issuer requested a hardship pause';
    case 'PauseApproved': return 'Hardship pause approved';
    case 'PauseEnded': return 'Hardship pause ended';
    case 'StatusChanged': return `Status: ${p.from} → ${p.to}`;
    case 'FormalNoticeDue': return `Formal notice due for ${p.periodId}`;
    case 'TermsAmended': return 'Terms amended (issuer-favourable)';
    case 'SeriesExtinguished': return 'Series extinguished';
    case 'TransferWindowOpened': return `Transfer window ${p.windowId} opened`;
    case 'TransferWindowCleared': return `Transfer window ${p.windowId} cleared: ${p.unitsTransferred} units moved`;
    case 'UnitsTransferred': return `${p.units} units transferred in window ${p.windowId}`;
    case 'CurveGraduated': return `Curve filled: the raise settled with ${p.unitsSold} base units sold`;
    case 'CurveUnitsSynced': return `Units counted: ${p.unitsOutstanding} base units outstanding`;
    case 'UnitsStaked': return `${p.units} base units staked`;
    case 'UnitsUnstaked': return `${p.units} base units unstaked`;
    case 'FxFallbackFlagged': return `FX fallback flagged for ${p.pair} ${p.periodId}`;
    default: return null; // RateSnapshot, AllowlistUpdated, AttestorRegistered, AttestorRevoked, VerifierKeyRegistered, VerifierKeyRevoked, HolderRegistered, FeeTaken, refunds, treasury, splits, curve proceeds: not in the public feed
  }
}

/** A curve-mode series (its units are base lamports; only staked units earn and only tenders burn). */
async function isCurve(client: PoolClient, seriesId: string): Promise<boolean> {
  const r = await client.query<{ raise_style: string }>('select raise_style from series where series_id = $1', [seriesId]);
  return r.rows[0]?.raise_style === 'curve';
}

const money = (client: PoolClient, e: DomainEvent, kind: string, amount: string, extra: { periodId?: string | null; wallet?: string | null; detail?: Record<string, unknown> } = {}) =>
  client.query('insert into money_events (chain, seq, series_id, period_id, kind, wallet, amount, detail, block_time, tx_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing', [
    e.chain, e.seq, (e.payload as { seriesId: string }).seriesId, extra.periodId ?? null, kind, extra.wallet ?? null, amount, JSON.stringify(extra.detail ?? {}), e.blockTime, e.txId,
  ]);

/** Apply one finalized event to the read model. Every statement is an upsert keyed by (chain, seq) or by the entity, so replay is harmless. */
export async function project(client: PoolClient, e: DomainEvent): Promise<void> {
  const sid = (e.payload as { seriesId?: string }).seriesId ?? null;
  const act = summary(e);
  if (act) await client.query('insert into activity (chain, seq, series_id, kind, summary, block_time) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [e.chain, e.seq, sid, e.type, act, e.blockTime]);

  switch (e.type) {
    case 'IssuerRegistered': {
      const p = e.payload as P<'IssuerRegistered'>;
      await client.query('insert into issuers (chain, issuer, registered_at) values ($1,$2,$3) on conflict do nothing', [e.chain, p.issuer, e.blockTime]);
      break;
    }
    case 'IssuanceStopped': {
      const p = e.payload as P<'IssuanceStopped'>;
      await client.query('update issuers set issuance_stopped = true where chain = $1 and issuer = $2', [e.chain, p.issuer]);
      break;
    }
    case 'SeriesCreated': {
      const p = e.payload as P<'SeriesCreated'>;
      const t = p.terms;
      await client.query(
        `insert into series (series_id, chain, issuer, stablecoin, stablecoin_mint, raise_style, units_offered, reserve_price, minimum_raise, cap_multiple_wad, lockup_seconds, release_schedule,
           auction_fee_bps, payout_fee_bps, hurdle_wad, payout_multiple_k, wallet_cap_bps, due_days, grace_days, formal_notice_days, contract_hash, terms_commitment, tier_flags, reporting_currency, created_at, last_event_seq,
           commit_duration_seconds, reveal_duration_seconds, non_reveal_charge_bps, unit_scale)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) on conflict (series_id) do nothing`,
        [p.seriesId, e.chain, p.issuer, t.stablecoin, t.stablecoinMint, t.raiseStyle, t.unitsOffered, t.reservePrice, t.minimumRaise, t.capMultipleWad, t.lockupSeconds, JSON.stringify(t.releaseSchedule), t.auctionFeeBps, t.payoutFeeBps, t.hurdleWad, t.payoutMultipleK, t.walletCapBps, t.dueDays, t.graceDays, t.formalNoticeDays, t.contractHash, t.termsCommitment, JSON.stringify(t.tierFlags), t.reportingCurrency, e.blockTime, e.seq,
          t.commitDurationSeconds, t.revealDurationSeconds, t.nonRevealChargeBps, unitScaleOf(t.raiseStyle).toString()],
      );
      break;
    }
    case 'CurveActivated': {
      // a curve's activation (its creation here): the pool, P0 and the units sold are fixed now (Stage 1 registry
      // `mark_curve_activated`), so the issue price and the cap per unit are known while the curve sells
      const p = e.payload as P<'CurveActivated'>;
      const s = await client.query<{ cap_multiple_wad: string; minimum_raise: string }>('select cap_multiple_wad::text, minimum_raise::text from series where series_id = $1', [p.seriesId]);
      const row = s.rows[0];
      const cap = row ? capPerUnit(BigInt(row.cap_multiple_wad), BigInt(p.issuePrice)).toString() : null;
      await client.query(
        'insert into curves (series_id, dbc_config, dbc_pool, base_mint, dbc_creator, migration_quote_threshold, issue_price, units_sold) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (series_id) do nothing',
        [p.seriesId, p.dbcConfig, p.dbcPool, p.baseMint, p.dbcCreator, row?.minimum_raise ?? '0', p.issuePrice, p.unitsSold],
      );
      await client.query("update series set phase = 'Open', opened_at = $2, issue_price = $3, units_sold = $4, cap_per_unit = $5, last_event_seq = $6 where series_id = $1", [p.seriesId, e.blockTime, p.issuePrice, p.unitsSold, cap, e.seq]);
      break;
    }
    case 'RaiseOpened': {
      // a curve's activation opens its raise with 0 and 0 (no commit or reveal phase): recorded as no phase ends
      const p = e.payload as P<'RaiseOpened'>;
      await client.query("update series set phase = 'Open', opened_at = $2, commit_ends_at = nullif($3::bigint, 0), reveal_ends_at = nullif($4::bigint, 0), last_event_seq = $5 where series_id = $1", [p.seriesId, e.blockTime, p.commitEndsAt, p.revealEndsAt, e.seq]);
      break;
    }
    case 'RaiseCancelled':
      await client.query("update series set phase = 'Cancelled', last_event_seq = $2 where series_id = $1", [sid, e.seq]);
      break;
    case 'BidCommitted': {
      const p = e.payload as P<'BidCommitted'>;
      await client.query('insert into bids (series_id, bidder, commitment, deposit, bid_order) values ($1,$2,$3,$4,$5) on conflict do nothing', [p.seriesId, p.bidder, p.commitment, p.deposit, p.order]);
      break;
    }
    case 'BidRevealed': {
      const p = e.payload as P<'BidRevealed'>;
      // validity is fixed at reveal (Stage 1 `isBidValid`); an invalid bid is refunded in full at processing
      await client.query('update bids set revealed_price = $3, revealed_quantity = $4, valid = $5 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.pricePerUnit, p.quantity, p.valid]);
      break;
    }
    case 'AuctionSettled': {
      const p = e.payload as P<'AuctionSettled'>;
      const s = await client.query<{ cap_multiple_wad: string; lockup_seconds: string }>('select cap_multiple_wad, lockup_seconds from series where series_id = $1', [p.seriesId]);
      const row = s.rows[0];
      // Stage 1's cap per unit, `mulDiv(capMultipleWad, P0, WAD)` (floor), the figure the chain enforces
      const cap = row ? capPerUnit(BigInt(row.cap_multiple_wad), BigInt(p.clearingPrice)).toString() : null;
      await client.query(
        // the reporting ledger starts at the settlement quarter (Stage 1 first_period, SIM:972). Stage 1 moves the money
        // bid by bid at processing (TreasuryFunded) and makes the units outstanding at the last process
        // (RaiseMintFinalized), so neither is set here
        "update series set phase = 'Settled', settled_at = $2, issue_price = $3, units_sold = $4, cap_per_unit = $5, lockup_ends_at = $2 + lockup_seconds, first_period = $7, next_expected_period = coalesce(next_expected_period, $7), last_event_seq = $6 where series_id = $1",
        [p.seriesId, p.settledAt, p.clearingPrice, p.unitsSold, cap, e.seq, periodAt(p.settledAt)],
      );
      // the auction's own results (migration 019), as finalize_settlement wrote them
      await client.query('update series set auction_clearing_price = $2, auction_units_sold = $3, auction_proceeds = $4, auction_failure_reason = null, auction_finalized_at = $5 where series_id = $1', [p.seriesId, p.clearingPrice, p.unitsSold, p.proceeds, p.settledAt]);
      break;
    }
    case 'AuctionFailed': {
      // a failed raise keeps its price and would-be results on the auction (Stage 1); the series' issue price stays unset.
      // NoValidBids found no price: the chains' RaiseFailed carries 0 there (as the event does), and the read model
      // records null, as the chain's auction read and the API contract do
      const p = e.payload as P<'AuctionFailed'>;
      const clearingPrice = p.reason === 'NoValidBids' ? null : p.clearingPrice;
      await client.query(
        "update series set phase = 'Failed', auction_failure_reason = $2, auction_clearing_price = $3, auction_units_sold = $4, auction_proceeds = $5, auction_finalized_at = $6, last_event_seq = $7 where series_id = $1",
        [p.seriesId, p.reason, clearingPrice, p.unitsSold, p.proceeds, e.blockTime, e.seq],
      );
      break;
    }
    case 'SettlementProposed': {
      const p = e.payload as P<'SettlementProposed'>;
      await client.query('insert into settlement_rounds (series_id, round, clearing_price, proposed_seq) values ($1,$2,$3,$4) on conflict (series_id, round) do nothing', [p.seriesId, p.round, p.clearingPrice, e.seq]);
      await client.query("update series set phase = 'Settling', settlement_round = $2, round_rejected = false, rejection_reason = null, last_event_seq = $3 where series_id = $1", [p.seriesId, p.round, e.seq]);
      break;
    }
    case 'SettlementRejected': {
      const p = e.payload as P<'SettlementRejected'>;
      await client.query('update settlement_rounds set rejected = true, rejection_reason = $3 where series_id = $1 and round = $2', [p.seriesId, p.round, p.reason]);
      await client.query('update series set round_rejected = true, rejection_reason = $3, last_event_seq = $4 where series_id = $1 and settlement_round = $2', [p.seriesId, p.round, p.reason, e.seq]);
      break;
    }
    case 'UnitsAllocated': {
      // a winner processed: its units are minted to the auction escrow for it and count toward its accrual weight until
      // delivered (SPEC §6.3), so they join the position now as undelivered units
      const p = e.payload as P<'UnitsAllocated'>;
      await client.query('update bids set processed = true, allocated_units = $3, cost = $4, fee = $5, pending_units = $3, pending_refund = $6 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.units, p.cost, p.fee, p.refund]);
      await client.query(
        'insert into positions (series_id, wallet, units, undelivered_units, first_seq, last_seq) values ($1,$2,$3,$3,$4,$4) on conflict (series_id, wallet) do update set units = positions.units + excluded.units, undelivered_units = positions.undelivered_units + excluded.undelivered_units, last_seq = excluded.last_seq where positions.last_seq < excluded.last_seq',
        [p.seriesId, p.bidder, p.units, e.seq],
      );
      break;
    }
    case 'BidDelivered': {
      // delivery implies processing (losers are processed without an event): the bid is marked processed here too
      const p = e.payload as P<'BidDelivered'>;
      await client.query('update bids set processed = true, delivered = true, delivered_units = $3, refunded = refunded + $4, pending_units = 0, pending_refund = 0 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.units, p.refund]);
      if (BigInt(p.units) > 0n) await client.query('update positions set undelivered_units = greatest(undelivered_units - $3, 0), last_seq = greatest(last_seq, $4) where series_id = $1 and wallet = $2', [p.seriesId, p.bidder, p.units, e.seq]);
      if (BigInt(p.refund) > 0n) await money(client, e, 'refund', p.refund, { wallet: p.bidder });
      break;
    }
    case 'NonRevealCharged': {
      // an unrevealed bid on a settled raise, processed (Stage 1 `process_bid`): the charge went to the fee collector (its
      // FeeTaken{nonReveal} follows and writes the fee row) and the bid is owed the rest of its deposit until delivered
      const p = e.payload as P<'NonRevealCharged'>;
      await client.query('update bids set processed = true, non_reveal_charge = $3, pending_refund = deposit - $3 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.charge]);
      break;
    }
    case 'RaiseMintFinalized': {
      // the last process_bid: every bid of the series is processed (losers emit nothing), and a settled raise's units
      // become outstanding (Stage 1 sets units_outstanding here, not at settlement). A bid processed without an event (a
      // loser, an invalid bid, an unrevealed bid charged 0, every bid of a failed raise) is owed its deposit in full until
      // delivered (Stage 1 `processBid` with no allocation and no charge), so the row stays whole for the reads that fall
      // back to it (/me/bids); a charged bid was written by its NonRevealCharged
      // A curve's completion finalises its mint too, but its units outstanding come from its census (Stage 1
      // `complete_curve` takes none), so they stay as they are
      const p = e.payload as P<'RaiseMintFinalized'>;
      await client.query("update series set mint_finalized = true, units_outstanding = case when phase = 'Settled' and raise_style = 'sealed' then $2::numeric else units_outstanding end, last_event_seq = $3 where series_id = $1", [p.seriesId, p.unitsSold, e.seq]);
      await client.query('update bids set pending_refund = case when not processed and not delivered then deposit else pending_refund end, processed = true where series_id = $1', [p.seriesId]);
      break;
    }
    case 'HolderRegistered': {
      // anyone may register any allowlisted wallet (Stage 1 `register_holder`), so a registration is recorded on its own
      // and never creates a position row: holder-tier access and /me/holdings need units held, ever (A-REV-10)
      const p = e.payload as P<'HolderRegistered'>;
      await client.query('insert into holder_registrations (series_id, wallet, registered_seq) values ($1,$2,$3) on conflict (series_id, wallet) do nothing', [p.seriesId, p.holder, e.seq]);
      break;
    }
    case 'TreasuryFunded': {
      // a sealed raise funds its treasury bid by bid at processing (each winner's cost, Stage 1 `process_bid`); a curve
      // at the collection that brings its proceeds (`collectCurveProceeds`; a curve buy never funds it). One treasury
      // money row each
      const p = e.payload as P<'TreasuryFunded'>;
      await client.query('update series set treasury_total = treasury_total + $2, last_event_seq = $3 where series_id = $1', [p.seriesId, p.amount, e.seq]);
      await money(client, e, 'treasury', p.amount);
      break;
    }
    case 'FundsReleased': {
      const p = e.payload as P<'FundsReleased'>;
      await client.query('update series set treasury_released = treasury_released + $2, last_event_seq = $3 where series_id = $1', [p.seriesId, p.amount, e.seq]);
      await money(client, e, 'release', p.amount, { detail: { trancheIndex: p.trancheIndex } });
      break;
    }
    case 'ReleasesPaused':
      await client.query('update series set releases_paused = true where series_id = $1', [sid]);
      break;
    case 'ReleasesResumed':
      await client.query('update series set releases_paused = false where series_id = $1', [sid]);
      break;
    case 'SplitReceipt': {
      const p = e.payload as P<'SplitReceipt'>;
      await client.query('insert into periods (series_id, period_id, split_received) values ($1,$2,$3) on conflict (series_id, period_id) do update set split_received = periods.split_received + excluded.split_received', [p.seriesId, p.periodId, p.amount]);
      await money(client, e, 'split', p.amount, { periodId: p.periodId, wallet: p.router });
      break;
    }
    case 'ReportAccepted': {
      const p = e.payload as P<'ReportAccepted'>;
      await client.query(
        `insert into periods (series_id, period_id, tier, payment_due, accrual, report_accepted, settled, prior_income_commitment, income_commitment, fx_basis, fx_avg_wad, liquidity_event, accepted_seq)
         values ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12)
         on conflict (series_id, period_id) do update set tier = excluded.tier, payment_due = excluded.payment_due, accrual = excluded.accrual, report_accepted = true, settled = periods.settled or excluded.settled,
           prior_income_commitment = excluded.prior_income_commitment, income_commitment = excluded.income_commitment, fx_basis = excluded.fx_basis, fx_avg_wad = excluded.fx_avg_wad, liquidity_event = excluded.liquidity_event, accepted_seq = excluded.accepted_seq`,
        [p.seriesId, p.periodId, p.tier, p.paymentDue, p.accrual, p.paymentDue === '0', p.priorIncomeCommitment, p.incomeCommitment, p.fxBasis, p.fxAvgWad, p.liquidityEvent, e.seq],
      );
      // the reporting ledger (SIM:1131-1148): reports are sequential; a zero due pays the period at once, any other
      // due opens it (paymentDue excludes accrual, which is charged at payment)
      await client.query(
        `update series set last_accepted_period = $2, next_expected_period = $3, last_income_period = $2, last_income_commitment = $4,
           last_paid_period = case when $5::numeric = 0 then $2 else last_paid_period end,
           open_due_period = case when $5::numeric = 0 then open_due_period else $2 end,
           open_due_amount = case when $5::numeric = 0 then open_due_amount else $5::numeric end,
           last_event_seq = $6 where series_id = $1`,
        [p.seriesId, p.periodId, nextPeriod(p.periodId), p.incomeCommitment, p.paymentDue, e.seq],
      );
      break;
    }
    case 'PaymentReceived': {
      const p = e.payload as P<'PaymentReceived'>;
      // gross_paid_total is what the issuer paid in (the chain's vault gross); an extinguishment returns the treasury
      // to holders through the same accumulator but is not an issuer payment, so only the per-unit figure moves
      const issuerGross = p.source === 'extinguishment' ? '0' : p.gross;
      await client.query('update series set paid_per_unit_wad = $2, gross_paid_total = gross_paid_total + $3, fees_total = fees_total + $4, last_event_seq = $5 where series_id = $1', [p.seriesId, p.paidPerUnitWad, issuerGross, p.fee, e.seq]);
      // payIn carries the due recomputed at payment time; older events without it keep the report-time figures
      if (p.periodId && p.source === 'payIn')
        await client.query(
          `insert into periods (series_id, period_id, paid, settled, payment_due, accrual) values ($1,$2,$3,true, coalesce($4::numeric, 0), coalesce($5::numeric, 0))
           on conflict (series_id, period_id) do update set paid = periods.paid + excluded.paid, settled = true,
             payment_due = coalesce($4::numeric, periods.payment_due), accrual = coalesce($5::numeric, periods.accrual)`,
          [p.seriesId, p.periodId, p.gross, p.paymentDue ?? null, p.accrual ?? null],
        );
      if (p.periodId && p.source === 'tail') await client.query('insert into periods (series_id, period_id, paid, settled) values ($1,$2,$3,true) on conflict (series_id, period_id) do update set paid = periods.paid + excluded.paid, settled = true', [p.seriesId, p.periodId, p.gross]);
      // paying the open due (a regular or a tail payment) closes it (SIM:1177-1180)
      if (p.periodId && (p.source === 'payIn' || p.source === 'tail')) await client.query('update series set last_paid_period = $2, open_due_period = null, open_due_amount = 0 where series_id = $1 and open_due_period = $2', [p.seriesId, p.periodId]);
      await money(client, e, 'payment', p.gross, { periodId: p.periodId, detail: { fee: p.fee, net: p.net, source: p.source } });
      break;
    }
    case 'PaymentRefunded': {
      const p = e.payload as P<'PaymentRefunded'>;
      await money(client, e, 'refund', p.amount, { periodId: p.periodId, detail: { reason: p.reason } });
      break;
    }
    case 'FeeTaken': {
      const p = e.payload as P<'FeeTaken'>;
      await client.query('insert into fees_ledger (chain, seq, series_id, kind, payer, amount, block_time, tx_id) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing', [e.chain, e.seq, p.seriesId, p.kind, p.payer, p.amount, e.blockTime, e.txId]);
      await money(client, e, 'fee', p.amount, { wallet: p.payer, detail: { kind: p.kind } });
      break;
    }
    case 'PayoutClaimed': {
      const p = e.payload as P<'PayoutClaimed'>;
      // the holder's own claim adds to an existing position only: a claim never creates one, so a wallet that only
      // registered (anyone may register any allowlisted wallet) and sent a claim of 0 gains no holder access
      // (A-REV-10). Stage 1's zero-amount rule makes a claim of nothing emit this event: it writes no money row. The
      // units the claim burns (a Retired balance) are the following UnitsBurned's; they are noted in the detail
      await client.query('update positions set claimed_total = claimed_total + $3, last_seq = greatest(last_seq, $4) where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.amount, e.seq]);
      if (BigInt(p.amount) > 0n) await money(client, e, 'payout', p.amount, { wallet: p.holder, detail: { burnedUnits: p.burnedUnits } });
      break;
    }
    case 'SeriesRetired':
      // the cap is met and nothing more is owed: Stage 1's `retire` clears the open due on every path (SIM:445-454),
      // also when a split receipt retires the series with a reported due unpaid (no payment can follow on a Retired series)
      await client.query('update series set open_due_period = null, open_due_amount = 0, last_event_seq = $2 where series_id = $1', [sid, e.seq]);
      break;
    case 'UnitsBurned': {
      const p = e.payload as P<'UnitsBurned'>;
      // Stage 1's zero-amount rule: `burnRetired` on a wallet holding nothing emits a burn of 0 units, which changes
      // nothing (any wallet, also one that never held units: no position row, no money row, no activity line)
      if (BigInt(p.units) === 0n) break;
      if (await isCurve(client, p.seriesId)) {
        // a curve's only burn is a tender (`tenderUnits`): staked and wallet units together. Units outstanding stay the
        // count taken at redemption (Stage 1 takes no census after it), and the position is the RedemptionClaimed's to
        // write (a wallet-only tender may have no row yet; only `fromStake` lowers the stake)
        await client.query('update series set tendered_total = tendered_total + $2, last_event_seq = $3 where series_id = $1', [p.seriesId, p.units, e.seq]);
      } else {
        await client.query('update positions set units = greatest(units - $3, 0), burned_units = burned_units + $3, last_seq = $4 where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.units, e.seq]);
        await client.query('update series set units_outstanding = greatest(units_outstanding - $2, 0), last_event_seq = $3 where series_id = $1', [p.seriesId, p.units, e.seq]);
      }
      await money(client, e, 'burn', p.units, { wallet: p.holder, detail: { reason: p.reason } });
      break;
    }
    case 'RedemptionOpened': {
      const p = e.payload as P<'RedemptionOpened'>;
      await client.query('update series set redeemed_at = $2, redemption_price = $3, last_event_seq = $4 where series_id = $1', [p.seriesId, e.blockTime, p.pricePerUnit, e.seq]);
      await money(client, e, 'redemption', p.deposit, { detail: { pricePerUnit: p.pricePerUnit, unitsOutstanding: p.unitsOutstanding, tailCapPerUnit: p.tailCapPerUnit, tailEndsAt: p.tailEndsAt } });
      break;
    }
    case 'RedemptionClaimed': {
      const p = e.payload as P<'RedemptionClaimed'>;
      // a holder's units are redeemed when it claims (Stage 1), not when the issuer redeems
      if (p.fromStake !== undefined) {
        // a curve tender (`tenderUnits`): the holder held and redeemed units, so the row is created when missing (a
        // registered holder that tendered only wallet units; amendment M3). Only the staked part lowers its stake (and
        // its accrual weight, which on a curve is the stake) and the series' stakes; the units burned are all of them
        await client.query(
          `insert into positions (series_id, wallet, units, staked_units, redeemed_units, burned_units, first_seq, last_seq) values ($1,$2,0,0,$3,$3,$5,$5)
           on conflict (series_id, wallet) do update set redeemed_units = positions.redeemed_units + $3, burned_units = positions.burned_units + $3,
             staked_units = greatest(positions.staked_units - $4, 0), units = greatest(positions.units - $4, 0), last_seq = greatest(positions.last_seq, $5)`,
          [p.seriesId, p.holder, p.units, p.fromStake, e.seq],
        );
        await client.query('update series set staked_total = greatest(staked_total - $2, 0), last_event_seq = $3 where series_id = $1', [p.seriesId, p.fromStake, e.seq]);
      } else {
        await client.query('update positions set redeemed_units = redeemed_units + $3, last_seq = greatest(last_seq, $4) where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.units, e.seq]);
      }
      await money(client, e, 'redemption_claim', p.amount, { wallet: p.holder, detail: { units: p.units, ...(p.fromStake !== undefined ? { fromStake: p.fromStake } : {}) } });
      break;
    }
    case 'TailClaimed': {
      const p = e.payload as P<'TailClaimed'>;
      // the holder's own claim adds to an existing position only: a claim never creates one, so it grants no holder
      // access (A-REV-10); a zero claim writes no money row
      await client.query('update positions set claimed_total = claimed_total + $3, last_seq = greatest(last_seq, $4) where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.amount, e.seq]);
      if (BigInt(p.amount) > 0n) await money(client, e, 'tail_claim', p.amount, { wallet: p.holder });
      break;
    }
    case 'FinalClaimed': {
      const p = e.payload as P<'FinalClaimed'>;
      // as TailClaimed: an existing position only, no money row for a zero claim; the weight goes in the detail
      await client.query('update positions set claimed_total = claimed_total + $3, last_seq = greatest(last_seq, $4) where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.amount, e.seq]);
      if (BigInt(p.amount) > 0n) await money(client, e, 'final_claim', p.amount, { wallet: p.holder, detail: { units: p.units } });
      break;
    }
    case 'TailPayout': {
      const p = e.payload as P<'TailPayout'>;
      await money(client, e, 'tail', p.total, { periodId: p.periodId, detail: { perUnit: p.perUnit } });
      break;
    }
    case 'StatusChanged': {
      const p = e.payload as P<'StatusChanged'>;
      await client.query('update series set status = $2, last_event_seq = $3 where series_id = $1', [p.seriesId, p.to, e.seq]);
      await client.query('insert into status_history (chain, seq, series_id, from_status, to_status, block_time) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [e.chain, e.seq, p.seriesId, p.from, p.to, e.blockTime]);
      break;
    }
    case 'FormalNoticeDue': {
      const p = e.payload as P<'FormalNoticeDue'>;
      await client.query('insert into periods (series_id, period_id, formal_notice_seq) values ($1,$2,$3) on conflict (series_id, period_id) do update set formal_notice_seq = coalesce(periods.formal_notice_seq, excluded.formal_notice_seq)', [p.seriesId, p.periodId, e.seq]);
      await client.query('update series set formal_notice_emitted_for = $2 where series_id = $1', [p.seriesId, p.periodId]);
      break;
    }
    case 'TermsAmended': {
      const p = e.payload as P<'TermsAmended'>;
      // the live cap per unit after the amendment, computed here with Stage 1's `capPerUnit` (floor): a SQL `numeric`
      // division into numeric(38,0) rounds half up (2.5e18 × 105,000,001 gives 262,500,003 where the chain has 262,500,002)
      const s = await client.query<{ issue_price: string | null }>('select issue_price::text from series where series_id = $1', [p.seriesId]);
      const issuePrice = s.rows[0]?.issue_price ?? null;
      const cap = issuePrice === null ? null : capPerUnit(BigInt(p.capMultipleWad), BigInt(issuePrice)).toString();
      await client.query('update series set terms_commitment = $2, cap_multiple_wad = $3, cap_per_unit = $4, last_event_seq = $5 where series_id = $1', [p.seriesId, p.termsCommitment, p.capMultipleWad, cap, e.seq]);
      break;
    }
    case 'SeriesExtinguished': {
      const p = e.payload as P<'SeriesExtinguished'>;
      // only the unvested proceeds return to holders (Stage 1 SIM:1431); the vested part stays in the treasury and the
      // issuer may still draw it, so `treasury_released` moves only with `FundsReleased`
      // nothing more is owed: the open due ends with the series (SIM:1438-1441)
      await client.query('update series set extinguished_at = $2, open_due_period = null, open_due_amount = 0, last_event_seq = $3 where series_id = $1', [p.seriesId, e.blockTime, e.seq]);
      await money(client, e, 'extinguishment', p.returnedToHolders, { detail: { attestors: p.attestors } });
      break;
    }
    case 'RateSnapshot': {
      const p = e.payload as P<'RateSnapshot'>;
      await client.query('insert into rate_snapshots (chain, pair, day_index, rate_wad, conf_wad, publish_time, sum_wad, count) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing', [e.chain, p.pair, p.dayIndex, p.rateWad, p.confWad, p.publishTime, p.sumWad, p.count]);
      break;
    }
    case 'FxFallbackFlagged': {
      const p = e.payload as P<'FxFallbackFlagged'>;
      await client.query('insert into fx_fallbacks (chain, pair, period_id, reason) values ($1,$2,$3,$4) on conflict do nothing', [e.chain, p.pair, p.periodId, p.reason]);
      break;
    }
    case 'AllowlistUpdated': {
      const p = e.payload as P<'AllowlistUpdated'>;
      await client.query('insert into allowlist (chain, wallet, allowed, updated_seq) values ($1,$2,$3,$4) on conflict (chain, wallet) do update set allowed = excluded.allowed, updated_seq = excluded.updated_seq where allowlist.updated_seq < excluded.updated_seq', [e.chain, p.wallet, p.allowed, e.seq]);
      break;
    }
    case 'AttestorRegistered': {
      // Stage 1's registration (S4 WP5): the key is active again and its revocation is cleared. `registered_at` is when
      // it became active: Solana re-emits the event for a key that is already active (merces_registry lib.rs:218-236),
      // which keeps it. `updated_seq` keeps a replayed or older event from undoing a later one
      const p = e.payload as P<'AttestorRegistered'>;
      await client.query(
        `insert into attestors (chain, attestor, active, registered_at, revoked_at, updated_seq) values ($1,$2,true,$3,null,$4)
         on conflict (chain, attestor) do update set active = true, revoked_at = null,
           registered_at = case when attestors.active then attestors.registered_at else excluded.registered_at end, updated_seq = excluded.updated_seq
         where attestors.updated_seq < excluded.updated_seq`,
        [e.chain, p.attestor, e.blockTime, e.seq],
      );
      break;
    }
    case 'AttestorRevoked': {
      // forward-only revocation: access ends at once (A-M5-2); report and FX signatures of periods that ended by
      // `revoked_at` stay valid on the chain for 45 days (Stage 1's grace), which the services read from the chain
      const p = e.payload as P<'AttestorRevoked'>;
      await client.query(
        `insert into attestors (chain, attestor, active, revoked_at, updated_seq) values ($1,$2,false,$3,$4)
         on conflict (chain, attestor) do update set active = false, revoked_at = excluded.revoked_at, updated_seq = excluded.updated_seq
         where attestors.updated_seq < excluded.updated_seq`,
        [e.chain, p.attestor, p.revokedAt, e.seq],
      );
      break;
    }
    case 'TransferWindowOpened': {
      const p = e.payload as P<'TransferWindowOpened'>;
      await client.query('insert into transfer_windows (series_id, window_id, commit_ends_at, reveal_ends_at) values ($1,$2,$3,$4) on conflict do nothing', [p.seriesId, p.windowId, p.commitEndsAt, p.revealEndsAt]);
      break;
    }
    case 'TransferWindowCleared': {
      const p = e.payload as P<'TransferWindowCleared'>;
      await client.query('update transfer_windows set cleared = true, clearing_price = $3, units_transferred = $4 where series_id = $1 and window_id = $2', [p.seriesId, p.windowId, p.clearingPrice, p.unitsTransferred]);
      break;
    }
    case 'UnitsTransferred': {
      const p = e.payload as P<'UnitsTransferred'>;
      await client.query('update positions set units = greatest(units - $3, 0), last_seq = $4 where series_id = $1 and wallet = $2', [p.seriesId, p.from, p.units, e.seq]);
      await client.query('insert into positions (series_id, wallet, units, first_seq, last_seq) values ($1,$2,$3,$4,$4) on conflict (series_id, wallet) do update set units = positions.units + excluded.units, last_seq = excluded.last_seq', [p.seriesId, p.to, p.units, e.seq]);
      break;
    }
    case 'CurveGraduated': {
      // Stage 1 `complete_curve`: the curve raise settles at the pool's finish time with the P0 and units sold fixed at
      // activation (the reporting ledger starts at that quarter). It funds no treasury (collection does) and sets no
      // units outstanding (the curve's census does); `RaiseMintFinalized` marks the mint final
      const p = e.payload as P<'CurveGraduated'>;
      await client.query('update curves set completed = true, settled_at = $2 where series_id = $1', [p.seriesId, p.settledAt]);
      const s = await client.query<{ cap_multiple_wad: string }>('select cap_multiple_wad::text from series where series_id = $1', [p.seriesId]);
      const row = s.rows[0];
      const cap = row ? capPerUnit(BigInt(row.cap_multiple_wad), BigInt(p.issuePrice)).toString() : null;
      await client.query(
        "update series set phase = 'Settled', settled_at = $2, issue_price = $3, units_sold = $4, cap_per_unit = $5, lockup_ends_at = $2 + lockup_seconds, first_period = $6, next_expected_period = coalesce(next_expected_period, $6), last_event_seq = $7 where series_id = $1",
        [p.seriesId, p.settledAt, p.issuePrice, p.unitsSold, cap, periodAt(p.settledAt), e.seq],
      );
      break;
    }
    case 'CurveProceedsCollected': {
      // what one collection moved: the migration fee and surplus reached the treasury (its `TreasuryFunded` follows),
      // the trading fee the fee collector (its `FeeTaken` follows); `proceeds` is the treasury's total after it
      const p = e.payload as P<'CurveProceedsCollected'>;
      await client.query('update curves set proceeds = $2, migration_fee = migration_fee + $3, surplus = surplus + $4, trading_fee = trading_fee + $5 where series_id = $1', [p.seriesId, p.proceeds, p.migrationFee, p.surplus, p.tradingFee]);
      break;
    }
    case 'CurveUnitsSynced': {
      // Stage 1 `store_curve_units`: a census (`syncCurveUnits`, or `redeem`'s own) becomes the series' units outstanding
      // (the vault's N, the stake bound and the report's public input) at the time it was taken; each census is kept
      const p = e.payload as P<'CurveUnitsSynced'>;
      await client.query('insert into curve_census (series_id, seq, supply, protocol_held, units_outstanding, staked_total, synced_at) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [p.seriesId, e.seq, p.supply, p.protocolHeld, p.unitsOutstanding, p.stakedTotal, e.blockTime]);
      await client.query('update series set units_outstanding = $2, units_synced_at = $3, staked_total = $4, last_event_seq = $5 where series_id = $1', [p.seriesId, p.unitsOutstanding, e.blockTime, p.stakedTotal, e.seq]);
      break;
    }
    case 'UnitsStaked':
    case 'UnitsUnstaked': {
      // curve staking (Stage 1 `stake_units` / `unstake_units`): the holder's stake after the change is in the event. On a
      // curve only staked units earn, so the position's units (its accrual weight) are its stake. The first stake creates
      // the row, which is holder access (A-REV-10: a curve holder holds units in the series' stake vault); a registration
      // alone never does. The series' stakes move by the units
      const p = e.payload as P<'UnitsStaked'>;
      await client.query(
        `insert into positions (series_id, wallet, units, staked_units, first_seq, last_seq) values ($1,$2,$3,$3,$4,$4)
         on conflict (series_id, wallet) do update set units = excluded.units, staked_units = excluded.staked_units, last_seq = excluded.last_seq where positions.last_seq < excluded.last_seq`,
        [p.seriesId, p.holder, p.staked, e.seq],
      );
      const delta = e.type === 'UnitsStaked' ? p.units : `-${p.units}`;
      await client.query('update series set staked_total = greatest(staked_total + $2::numeric, 0), last_event_seq = $3 where series_id = $1', [p.seriesId, delta, e.seq]);
      break;
    }
    case 'PauseRequested':
    case 'PauseApproved':
    case 'PauseEnded':
      break;
    case 'VerifierKeyRegistered': {
      // the report verifier's keys (S4 WP6, D10), projected as the attestor keys are: active again with its revocation
      // cleared; `registered_at` kept on a Solana re-emit for an active key; `updated_seq` against replays
      const p = e.payload as P<'VerifierKeyRegistered'>;
      await client.query(
        `insert into verifier_keys (chain, address, active, registered_at, revoked_at, updated_seq) values ($1,$2,true,$3,null,$4)
         on conflict (chain, address) do update set active = true, revoked_at = null,
           registered_at = case when verifier_keys.active then verifier_keys.registered_at else excluded.registered_at end, updated_seq = excluded.updated_seq
         where verifier_keys.updated_seq < excluded.updated_seq`,
        [e.chain, p.verifierKey, e.blockTime, e.seq],
      );
      break;
    }
    case 'VerifierKeyRevoked': {
      // forward-only: tier-2 attestations of periods that ended by `revoked_at` stay valid on the chain for 45 days
      const p = e.payload as P<'VerifierKeyRevoked'>;
      await client.query(
        `insert into verifier_keys (chain, address, active, revoked_at, updated_seq) values ($1,$2,false,$3,$4)
         on conflict (chain, address) do update set active = false, revoked_at = excluded.revoked_at, updated_seq = excluded.updated_seq
         where verifier_keys.updated_seq < excluded.updated_seq`,
        [e.chain, p.verifierKey, p.revokedAt, e.seq],
      );
      break;
    }
    default: {
      const never: never = e.type;
      void never;
    }
  }
  void DEFAULTS;
}

import type { PoolClient } from '@merces/db';
import type { DomainEvent, EventPayload } from '@merces/domain';
import { DEFAULTS } from '@merces/domain';
import { interim } from '@merces/math';

type P<T extends DomainEvent['type']> = EventPayload<T>;

/** Public activity summaries. Never an amount (R28). Unit counts and statuses only. */
function summary(e: DomainEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'IssuerRegistered': return 'Issuer registered';
    case 'SeriesCreated': return 'Series created';
    case 'CurveSeriesCreated': return 'Curve-mode series created';
    case 'RaiseOpened': return 'Raise opened for sealed bids';
    case 'RaiseCancelled': return 'Raise cancelled before any bids';
    case 'BidCommitted': return 'A sealed bid was committed';
    case 'BidRevealed': return 'A bid was revealed';
    case 'AuctionSettled': return `Auction settled: ${p.unitsSold} units sold`;
    case 'AuctionFailed': return `Auction failed (${p.reason}); all bids refunded`;
    case 'UnitsMinted': return `${p.units} units minted to a holder`;
    case 'FundsReleased': return `Treasury tranche ${p.trancheIndex} released to the issuer`;
    case 'ReleasesPaused': return `Treasury releases paused (${p.reason})`;
    case 'ReleasesResumed': return 'Treasury releases resumed';
    case 'ReportAccepted': return `Report accepted for ${p.periodId} (tier ${p.tier})`;
    case 'PaymentReceived': return `Payment received${p.periodId ? ` for ${p.periodId}` : ''}`;
    case 'PayoutClaimed': return 'A holder claimed a payout';
    case 'SeriesRetired': return 'Series reached its cap and retired';
    case 'UnitsBurned': return `${p.units} units burned (${p.reason})`;
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
    case 'CurveGraduated': return 'Curve graduated to the DEX';
    case 'FxFallbackFlagged': return `FX fallback flagged for ${p.pair} ${p.periodId}`;
    default: return null; // RateSnapshot, AllowlistUpdated, AttestorRegistered, VerifierKeyRegistered, FeeTaken, refunds, treasury, splits: not in the public feed
  }
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
           auction_fee_bps, payout_fee_bps, hurdle_wad, payout_multiple_k, wallet_cap_bps, due_days, grace_days, formal_notice_days, contract_hash, terms_commitment, tier_flags, reporting_currency, created_at, last_event_seq)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) on conflict (series_id) do nothing`,
        [p.seriesId, e.chain, p.issuer, t.stablecoin, t.stablecoinMint, t.raiseStyle, t.unitsOffered, t.reservePrice, t.minimumRaise, t.capMultipleWad, t.lockupSeconds, JSON.stringify(t.releaseSchedule), t.auctionFeeBps, t.payoutFeeBps, t.hurdleWad, t.payoutMultipleK, t.walletCapBps, t.dueDays, t.graceDays, t.formalNoticeDays, t.contractHash, t.termsCommitment, JSON.stringify(t.tierFlags), t.reportingCurrency, e.blockTime, e.seq],
      );
      break;
    }
    case 'CurveSeriesCreated': {
      const p = e.payload as P<'CurveSeriesCreated'>;
      await client.query('insert into curves (series_id, quote_stablecoin, graduation_threshold) values ($1,$2,$3) on conflict do nothing', [p.seriesId, p.quoteStablecoin, p.graduationThreshold]);
      break;
    }
    case 'RaiseOpened': {
      const p = e.payload as P<'RaiseOpened'>;
      await client.query("update series set phase = 'Open', opened_at = $2, commit_ends_at = $3, reveal_ends_at = $4, last_event_seq = $5 where series_id = $1", [p.seriesId, e.blockTime, p.commitEndsAt, p.revealEndsAt, e.seq]);
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
      await client.query('update bids set revealed_price = $3, revealed_quantity = $4 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.pricePerUnit, p.quantity]);
      break;
    }
    case 'AuctionSettled': {
      const p = e.payload as P<'AuctionSettled'>;
      const s = await client.query<{ cap_multiple_wad: string; lockup_seconds: string }>('select cap_multiple_wad, lockup_seconds from series where series_id = $1', [p.seriesId]);
      const row = s.rows[0];
      const cap = row ? interim.perUnitCap(BigInt(row.cap_multiple_wad), BigInt(p.clearingPrice)).toString() : null;
      await client.query(
        "update series set phase = 'Settled', settled_at = $2, issue_price = $3, units_sold = $4, units_outstanding = $4, cap_per_unit = $5, treasury_total = $6, lockup_ends_at = $2 + lockup_seconds, last_event_seq = $7 where series_id = $1",
        [p.seriesId, p.settledAt, p.clearingPrice, p.unitsSold, cap, p.proceeds, e.seq],
      );
      await money(client, e, 'treasury', p.proceeds, { detail: { clearingPrice: p.clearingPrice, unitsSold: p.unitsSold, totalFees: p.totalFees } });
      break;
    }
    case 'AuctionFailed':
      await client.query("update series set phase = 'Failed', last_event_seq = $2 where series_id = $1", [sid, e.seq]);
      break;
    case 'BidRefunded': {
      const p = e.payload as P<'BidRefunded'>;
      await client.query('update bids set refunded = refunded + $3 where series_id = $1 and bidder = $2', [p.seriesId, p.bidder, p.amount]);
      await money(client, e, 'refund', p.amount, { wallet: p.bidder });
      break;
    }
    case 'UnitsMinted': {
      const p = e.payload as P<'UnitsMinted'>;
      await client.query('update bids set allocated_units = allocated_units + $3 where series_id = $1 and bidder = $2', [p.seriesId, p.holder, p.units]);
      await client.query(
        'insert into positions (series_id, wallet, units, first_seq, last_seq) values ($1,$2,$3,$4,$4) on conflict (series_id, wallet) do update set units = positions.units + excluded.units, last_seq = excluded.last_seq where positions.last_seq < excluded.last_seq',
        [p.seriesId, p.holder, p.units, e.seq],
      );
      break;
    }
    case 'TreasuryFunded': {
      // an auction's proceeds are recorded on AuctionSettled; a curve funds its treasury buy by buy before graduation
      // (CurveGraduated then sets the same total), so only an ungraduated curve adds here
      const p = e.payload as P<'TreasuryFunded'>;
      await client.query("update series set treasury_total = treasury_total + $2, last_event_seq = $3 where series_id = $1 and raise_style = 'curve' and phase <> 'Settled'", [p.seriesId, p.amount, e.seq]);
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
        `insert into periods (series_id, period_id, tier, payment_due, accrual, report_accepted, settled, income_commitment, fx_basis, fx_avg_wad, liquidity_event, accepted_seq)
         values ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11)
         on conflict (series_id, period_id) do update set tier = excluded.tier, payment_due = excluded.payment_due, accrual = excluded.accrual, report_accepted = true, settled = periods.settled or excluded.settled,
           income_commitment = excluded.income_commitment, fx_basis = excluded.fx_basis, fx_avg_wad = excluded.fx_avg_wad, liquidity_event = excluded.liquidity_event, accepted_seq = excluded.accepted_seq`,
        [p.seriesId, p.periodId, p.tier, p.paymentDue, p.accrual, p.paymentDue === '0', p.incomeCommitment, p.fxBasis, p.fxAvgWad, p.liquidityEvent, e.seq],
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
      await client.query('insert into positions (series_id, wallet, claimed_total, first_seq, last_seq) values ($1,$2,$3,$4,$4) on conflict (series_id, wallet) do update set claimed_total = positions.claimed_total + excluded.claimed_total, last_seq = greatest(positions.last_seq, excluded.last_seq)', [p.seriesId, p.holder, p.amount, e.seq]);
      await money(client, e, 'payout', p.amount, { wallet: p.holder });
      break;
    }
    case 'SeriesRetired':
      await client.query('update series set last_event_seq = $2 where series_id = $1', [sid, e.seq]);
      break;
    case 'UnitsBurned': {
      const p = e.payload as P<'UnitsBurned'>;
      await client.query('update positions set units = greatest(units - $3, 0), burned_units = burned_units + $3, last_seq = $4 where series_id = $1 and wallet = $2', [p.seriesId, p.holder, p.units, e.seq]);
      await client.query('update series set units_outstanding = greatest(units_outstanding - $2, 0), last_event_seq = $3 where series_id = $1', [p.seriesId, p.units, e.seq]);
      await money(client, e, 'burn', p.units, { wallet: p.holder, detail: { reason: p.reason } });
      break;
    }
    case 'RedemptionOpened': {
      const p = e.payload as P<'RedemptionOpened'>;
      await client.query('update series set redeemed_at = $2, redemption_price = $3, last_event_seq = $4 where series_id = $1', [p.seriesId, e.blockTime, p.pricePerUnit, e.seq]);
      await client.query('update positions set redeemed_units = units where series_id = $1', [p.seriesId]);
      await money(client, e, 'redemption', p.deposit, { detail: { pricePerUnit: p.pricePerUnit, unitsOutstanding: p.unitsOutstanding, tailCapPerUnit: p.tailCapPerUnit, tailEndsAt: p.tailEndsAt } });
      break;
    }
    case 'RedemptionClaimed': {
      const p = e.payload as P<'RedemptionClaimed'>;
      await money(client, e, 'redemption_claim', p.amount, { wallet: p.holder, detail: { units: p.units } });
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
      break;
    }
    case 'TermsAmended': {
      const p = e.payload as P<'TermsAmended'>;
      await client.query('update series set terms_commitment = $2, cap_multiple_wad = $3, cap_per_unit = case when issue_price is null then null else ($3::numeric * issue_price) / 1000000000000000000 end, last_event_seq = $4 where series_id = $1', [p.seriesId, p.termsCommitment, p.capMultipleWad, e.seq]);
      break;
    }
    case 'SeriesExtinguished': {
      const p = e.payload as P<'SeriesExtinguished'>;
      // the chain marks the whole treasury released when it returns the unreleased part to holders
      await client.query('update series set extinguished_at = $2, treasury_released = treasury_total, last_event_seq = $3 where series_id = $1', [p.seriesId, e.blockTime, e.seq]);
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
      const p = e.payload as P<'AttestorRegistered'>;
      await client.query('insert into attestors (chain, attestor, active) values ($1,$2,$3) on conflict (chain, attestor) do update set active = excluded.active', [e.chain, p.attestor, p.active]);
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
      const p = e.payload as P<'CurveGraduated'>;
      await client.query('update curves set graduated = true, raised = $2 where series_id = $1', [p.seriesId, p.raised]);
      await client.query("update series set phase = 'Settled', settled_at = $2, units_sold = $3, units_outstanding = $3, treasury_total = $4, lockup_ends_at = $2 + lockup_seconds, last_event_seq = $5 where series_id = $1", [p.seriesId, e.blockTime, p.unitsOutstanding, p.raised, e.seq]);
      break;
    }
    case 'PauseRequested':
    case 'PauseApproved':
    case 'PauseEnded':
    case 'VerifierKeyRegistered':
      break;
    default: {
      const never: never = e.type;
      void never;
    }
  }
  void DEFAULTS;
}

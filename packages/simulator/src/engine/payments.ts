import { ChainError, type Command } from '@merces/domain';
import { interim, parsePeriod, periodOf } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { burn, settlePosition } from './holders.ts';
import { payTail, takeTail, yearIndex } from './redemption.ts';
import { accrualNow, periodRecord, setStatus, syncStatus } from './status.ts';
import { takeFinal } from './terminal.ts';

/** Common path for money entering the vault: fee, cap, accumulator, events. Returns accepted gross. */
export function receivePayment(e: EngineCore, s: SimSeries, payer: string, gross: bigint, periodId: string | null, source: 'payIn' | 'split' | 'tail', now: number, emit: Emit, due?: { paymentDue: bigint; accrual: bigint }): { accepted: bigint; refunded: bigint; net: bigint } {
  if (s.unitsOutstanding <= 0n) throw new ChainError('WrongStatus', 'no units outstanding');
  const mint = s.terms.stablecoinMint;
  e.debit(payer, mint, gross);
  const cap = interim.applyGrossPayment(gross, s.unitsOutstanding, s.paidPerUnitWad, s.capPerUnit!);
  if (cap.refunded > 0n) {
    e.credit(payer, mint, cap.refunded);
    emit('PaymentRefunded', { seriesId: s.seriesId, periodId, amount: str(cap.refunded), reason: 'cap' });
  }
  const accepted = cap.accepted;
  const { fee, net } = interim.payoutFee(accepted, s.terms.payoutFeeBps);
  if (fee > 0n) {
    e.credit(e.state.feeCollector, mint, fee);
    emit('FeeTaken', { seriesId: s.seriesId, kind: 'payout', amount: str(fee), payer });
  }
  s.paidPerUnitWad = cap.paidPerUnitWad;
  s.accNetWad = interim.accrueNet(s.accNetWad, net, s.unitsOutstanding);
  s.vaultBalance += net;
  s.vaultGrossTotal += accepted;
  s.vaultFeesTotal += fee;
  s.grossPaidTotal += accepted;
  s.feesTotal += fee;
  const y = yearIndex(s, now);
  s.grossByYear.set(y, (s.grossByYear.get(y) ?? 0n) + accepted);
  emit('PaymentReceived', { seriesId: s.seriesId, periodId, gross: str(accepted), fee: str(fee), net: str(net), source, paidPerUnitWad: str(s.paidPerUnitWad), ...(due ? { paymentDue: str(due.paymentDue), accrual: str(due.accrual) } : {}) });
  if (cap.retired && s.status !== 'Retired') {
    setStatus(s, 'Retired', emit);
    emit('SeriesRetired', { seriesId: s.seriesId, paidPerUnitWad: str(s.paidPerUnitWad) });
    if (s.releasesPausedLate) {
      // nothing more is owed once the cap is reached: the Late pause ends with the obligation
      s.releasesPausedLate = false;
      if (!s.releasesPausedByIssuer) emit('ReleasesResumed', { seriesId: s.seriesId });
    }
  }
  return { accepted, refunded: cap.refunded, net };
}

// ------------------------------------------------------------------ paying in
/**
 * The issuer pays the open due. WP5 replaces the body with Stage 1's vault path (`pay`, SIM:1151-1185); until then it
 * keeps the version-1 money path and, like Stage 1, closes the ledger's open due when the period settles
 * (`openDuePeriod`/`openDueAmount` cleared, `lastPaidPeriod` set), so the next report is not refused as
 * PaymentOutstanding.
 */
export function payIn(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'payIn' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  const p = s.periods.get(cmd.periodId);
  if (!p || !p.reportAccepted) throw new ChainError('NotFound', 'no accepted report for this period');
  if (p.settled) throw new ChainError('Duplicate', 'period already paid');
  const amount = big(cmd.amount);
  if (!p.isTail) {
    // interest runs until the payment lands, not until the report (C8.3)
    p.accrual = accrualNow(s, parsePeriod(cmd.periodId), p.outstanding, now);
    p.paymentDue = p.outstanding + p.accrual;
  }
  const remaining = p.paymentDue - p.paid;
  if (amount !== remaining) throw new ChainError('InvalidTerms', `payIn must equal the remaining due ${remaining}`);
  if (p.isTail) {
    // the tail cap applies when the money lands (Stage 1 `tailReceive`), no longer at the report: the payer is charged
    // the accepted part only and `PaymentRefunded` records the excess. WP6 moves this onto Stage 1's tail state.
    const r = s.redemption!;
    const perUnit = interim.tailPayoutPerUnit(amount / r.unitsAtRedemption, r.tailCapPerUnit, r.tailPaidPerUnit);
    const accepted = perUnit * r.unitsAtRedemption;
    if (accepted > 0n) payTail(e, s, signer, p, accepted, now, emit);
    if (amount > accepted) emit('PaymentRefunded', { seriesId: s.seriesId, periodId: p.periodId, amount: str(amount - accepted), reason: 'cap' });
  } else {
    // `paid` records what the vault accepted; a cap refund (PaymentRefunded) is not part of it (A-C6-1)
    // publish the due recomputed at payment time so read models do not keep the report-time figures
    const r = receivePayment(e, s, signer, amount, cmd.periodId, 'payIn', now, emit, { paymentDue: p.paymentDue, accrual: p.accrual });
    p.paid += r.accepted;
    p.accrualPaid = p.accrual;
  }
  p.settled = true;
  p.paidAt = now;
  // close the ledger's open due (SIM:1177-1180, 1162-1164)
  const l = s.ledger;
  l.lastPaidPeriod = p.pid;
  if (l.openDuePeriod === p.pid) {
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
  }
  syncStatus(e, s, now, emit);
}
export function postSplitReceipt(e: EngineCore, router: string, cmd: Extract<Command, { kind: 'postSplitReceipt' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.splitRouter !== router) throw new ChainError('Unauthorized', 'router not registered for this series');
  if (s.phase !== 'Settled' || TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series cannot receive split income');
  const amount = big(cmd.amount);
  const periodId = periodOf(now).id;
  const { accepted } = receivePayment(e, s, router, amount, periodId, 'split', now, emit);
  periodRecord(s, periodId).splitReceived += accepted;
  emit('SplitReceipt', { seriesId: s.seriesId, periodId, amount: str(accepted), router });
}

// ------------------------------------------------------------------ payouts, burns
export function claimPayout(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimPayout' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const p = s.positions.get(signer);
  if (!p) throw new ChainError('NotFound', 'no position');
  settlePosition(s, p);
  let amount = p.pending;
  p.pending = 0n;
  amount += takeTail(e, s, p);
  amount += takeFinal(e, s, p, emit);
  if (amount <= 0n) throw new ChainError('NotFound', 'nothing to claim');
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
  s.vaultBalance -= amount;
  s.vaultDistributedNet += amount;
  p.claimedTotal += amount;
  e.credit(signer, s.terms.stablecoinMint, amount);
  emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(amount) });
  if ((s.status === 'Retired' || s.status === 'Extinguished') && p.units > 0n) burn(s, p, s.status === 'Retired' ? 'cap' : 'extinguishment', emit);
}
export function crankBurn(e: EngineCore, cmd: Extract<Command, { kind: 'crankBurn' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Retired' && s.status !== 'Extinguished') throw new ChainError('WrongStatus', 'units are burnable only when Retired or Extinguished');
  let any = false;
  for (const h of cmd.holders) {
    const p = s.positions.get(h);
    if (p && p.units > 0n) {
      burn(s, p, s.status === 'Retired' ? 'cap' : 'extinguishment', emit);
      any = true;
    }
  }
  if (!any) throw new ChainError('NotFound', 'nothing to burn');
}

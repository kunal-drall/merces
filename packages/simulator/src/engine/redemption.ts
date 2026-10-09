import { ChainError, DEFAULTS, type Command } from '@merces/domain';
import { interim, WAD } from '@merces/math';
import type { SimPeriod, SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { burn, settlePosition } from './holders.ts';
import { isPeriodSettled, reportablePeriods, setStatus } from './status.ts';

export function yearIndex(s: SimSeries, now: number): number {
  return Math.floor((now - (s.settledAt ?? now)) / (365 * 86_400));
}
/** Per-unit gross for each FULL year since settlement (for D_avg). */
export function annualGrossPerUnit(s: SimSeries, now: number): bigint[] {
  const full = yearIndex(s, now);
  const out: bigint[] = [];
  for (let y = 0; y < full; y++) {
    const g = s.grossByYear.get(y) ?? 0n;
    out.push(s.unitsSold > 0n ? g / s.unitsSold : 0n);
  }
  return out;
}

// ------------------------------------------------------------------ redemption
export function quote(s: SimSeries, now: number) {
  return interim.redemptionQuote({ capPerUnit: s.capPerUnit!, paidPerUnitWad: s.paidPerUnitWad, issuePrice: s.issuePrice!, hurdleWad: s.terms.hurdleWad, payoutMultipleK: s.terms.payoutMultipleK, settlementTs: s.settledAt!, nowTs: now, annualGrossPerUnit: annualGrossPerUnit(s, now) });
}
export function redeem(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'redeem' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
  if (TERMINAL.has(s.status) || s.status === 'Paused') throw new ChainError('WrongStatus', `cannot redeem while ${s.status}`);
  if (now < s.settledAt! + s.terms.lockupSeconds) throw new ChainError('TooEarly', 'lockup has not ended');
  for (const per of reportablePeriods(s, now)) if (!isPeriodSettled(s, per.id)) throw new ChainError('WrongStatus', `period ${per.id} must be reported and paid before redemption (A-RED-1)`);
  const q = quote(s, now);
  if (q.pricePerUnit > big(cmd.maxPricePerUnit)) throw new ChainError('InvalidTerms', `price ${q.pricePerUnit} exceeds maxPricePerUnit`);
  const deposit = q.pricePerUnit * s.unitsOutstanding;
  e.debit(signer, s.terms.stablecoinMint, deposit);
  const tailEndsAt = now + DEFAULTS.tailMonths * 30 * 86_400;
  s.redemption = { openedAt: now, pricePerUnit: q.pricePerUnit, unitsAtRedemption: s.unitsOutstanding, deposit, claimed: 0n, tailCapPerUnit: q.tailCapPerUnit, tailEndsAt, tailPaidPerUnit: 0n, accTailNetWad: 0n };
  for (const p of s.positions.values()) {
    p.redeemedUnits = p.units;
    p.tailDebt = 0n;
  }
  emit('RedemptionOpened', { seriesId: s.seriesId, pricePerUnit: str(q.pricePerUnit), unitsOutstanding: str(s.unitsOutstanding), deposit: str(deposit), tailCapPerUnit: str(q.tailCapPerUnit), tailEndsAt });
  setStatus(s, 'Redeemed', emit);
}
export function claimRedemption(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimRedemption' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const r = s.redemption;
  if (!r) throw new ChainError('WrongStatus', 'no redemption open');
  const p = s.positions.get(signer);
  if (!p || p.units === 0n) throw new ChainError('NotFound', 'no units to redeem');
  redeemBody(e, s, p, emit);
}
/** A holder's redemption: settle and pay what is pending, pay the price for every unit, burn them. */
export function redeemBody(e: EngineCore, s: SimSeries, p: SimPosition, emit: Emit): void {
  const r = s.redemption!;
  const signer = p.wallet;
  const units = p.units;
  const amount = r.pricePerUnit * units;
  // settle any outstanding payouts first so nothing is stranded by the burn
  settlePosition(s, p);
  const pending = p.pending;
  p.pending = 0n;
  if (pending > 0n) {
    s.vaultBalance -= pending;
    s.vaultDistributedNet += pending;
    p.claimedTotal += pending;
    e.credit(signer, s.terms.stablecoinMint, pending);
    emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(pending) });
  }
  r.claimed += amount;
  p.redemptionClaimed = true;
  e.credit(signer, s.terms.stablecoinMint, amount);
  burn(s, p, 'redemption', emit);
  emit('RedemptionClaimed', { seriesId: s.seriesId, holder: signer, units: str(units), amount: str(amount) });
}

// ------------------------------------------------------------------ tail
/** The issuer pays a tail period's due after a redemption: fee, tail accumulator, events. */
export function payTail(e: EngineCore, s: SimSeries, signer: string, p: SimPeriod, amount: bigint, _now: number, emit: Emit): void {
  const r = s.redemption!;
  const mint = s.terms.stablecoinMint;
  e.debit(signer, mint, amount);
  const { fee, net } = interim.payoutFee(amount, s.terms.payoutFeeBps);
  if (fee > 0n) {
    e.credit(e.state.feeCollector, mint, fee);
    emit('FeeTaken', { seriesId: s.seriesId, kind: 'payout', amount: str(fee), payer: signer });
  }
  r.accTailNetWad += interim.mulDiv(net, WAD, r.unitsAtRedemption);
  r.tailPaidPerUnit += amount / r.unitsAtRedemption;
  s.vaultBalance += net;
  s.vaultGrossTotal += amount;
  s.vaultFeesTotal += fee;
  s.grossPaidTotal += amount;
  s.feesTotal += fee;
  emit('PaymentReceived', { seriesId: s.seriesId, periodId: p.periodId, gross: str(amount), fee: str(fee), net: str(net), source: 'tail', paidPerUnitWad: str(s.paidPerUnitWad) });
  emit('TailPayout', { seriesId: s.seriesId, periodId: p.periodId, perUnit: str(amount / r.unitsAtRedemption), total: str(amount) });
  p.paid += amount;
}
/** The tail a holder could take now, without moving its cursor (the read side of `takeTail`). */
export function claimableTail(s: SimSeries, p: SimPosition): bigint {
  return s.redemption && p.redeemedUnits > 0n ? interim.claimable(p.redeemedUnits, s.redemption.accTailNetWad, p.tailDebt) : 0n;
}
/** The tail a holder can take now; moves the holder's tail cursor. */
export function takeTail(_e: EngineCore, s: SimSeries, p: SimPosition): bigint {
  let amount = 0n;
  if (s.redemption && p.redeemedUnits > 0n) {
    const tail = interim.claimable(p.redeemedUnits, s.redemption.accTailNetWad, p.tailDebt);
    p.tailDebt = interim.rewardDebt(p.redeemedUnits, s.redemption.accTailNetWad);
    amount += tail;
  }
  return amount;
}

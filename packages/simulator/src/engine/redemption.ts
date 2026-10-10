import { DEFAULTS, ChainError, type Command } from '@merces/domain';
import { U64_MAX, WAD, newTailState, pidAt, redemptionQuote, settleHolderDelta, tailReceive, type RedemptionQuote } from '@merces/math';
import type { SimPeriod, SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { fail, guardStage1 } from './errors.ts';
import { accrualUnits, burnUnits, settleHolder } from './holders.ts';
import { derivedStatus, liveCapPerUnit, mintFinalized, retire, setStatus } from './ledger.ts';
import { deliverPending } from './settlement.ts';
import { syncStatus } from './status.ts';

/**
 * Redemption and the tail clause on Stage 1 (SPEC v1.1 §6.7-§6.8; Stage 1 simulator SIM:1158-1172, 1328-1412),
 * through `@merces/math`: Stage 1's `redemptionQuote` over the vault's tagged year ring, `newTailState` at redemption,
 * `tailReceive` for every tail payment and the holder's tail cursor (`lastTailAccWad`).
 */

// ------------------------------------------------------------------ redemption
/**
 * Stage 1's redemption quote at `now` (`redemptionQuote`, REF/redemption.ts:58-78): the hurdle price, `k × D_avg`
 * over the trailing full settlement years of `vault.yearGross` (each payment is tagged with the year of its report
 * deadline), the remaining cap `C_rem` from the live cap and `vault.paidPerUnitWad` (ceil), and the price the
 * smallest of them decides. Meaningful once the raise settled.
 */
export function quote(s: SimSeries, now: number): RedemptionQuote {
  return guardStage1(() => redemptionQuote({
    p0: s.issuePrice ?? 0n,
    hurdleRateWad: s.terms.hurdleWad,
    payoutMultipleK: Number(s.terms.payoutMultipleK),
    t: BigInt(now - (s.settledAt ?? now)),
    capPerUnit: liveCapPerUnit(s),
    paidPerUnitWad: s.vault.paidPerUnitWad,
    yearGross: s.vault.yearGross,
    unitsOutstanding: s.unitsOutstanding,
  }), 'AmountOutOfRange');
}

/**
 * Stage 1 `redeem` (SIM:1328-1367). Checks, in order:
 *
 *  1. the issuer signs (NotIssuer);
 *  2. the raise settled (RaiseNotSettled) and its last bid is processed (MintNotFinalized);
 *  3. the derived status is not terminal (TerminalStatus) and not Late (SeriesLate); **Paused is allowed**;
 *  4. the lockup has ended (LockupActive);
 *  5. nothing is due (PaymentOutstanding) and no true-up is due (TrueUpOutstanding; 0 until S5);
 *  6. every ended period is reported: `lastEnded = pidAt(now) − 1` is before the first period or at most the last
 *     accepted one (UnreportedPeriods);
 *  7. ours: the quoted price is within `maxPricePerUnit` (InvalidTerms; Stage 1 has no slippage bound).
 *
 * Then `syncStatus` (a sync point, after the quote). With nothing left of the cap (`C_rem = 0`) the series retires
 * instead and nothing is deposited. Otherwise the issuer deposits `P_redeem × N` (u64) **into the vault**, the series
 * becomes Redeemed, the tail starts (`newTailState(C_rem − P_redeem)`, running `DEFAULTS.tailSeconds`), and holders'
 * `redeemedUnits` are left alone: each holder's units are redeemed when it claims (`redeemBody`).
 */
export function redeem(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'redeem' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may redeem');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  if (!mintFinalized(s)) fail('MintNotFinalized', 'the raise is still processing its bids');
  const l = s.ledger;
  const status = derivedStatus(s, now);
  if (TERMINAL.has(status)) fail('TerminalStatus', `series is ${status}`);
  if (status === 'Late') fail('SeriesLate', 'a late series cannot redeem');
  if (now < s.settledAt! + s.terms.lockupSeconds) fail('LockupActive', 'the lockup has not ended');
  if (l.openDueAmount > 0n) fail('PaymentOutstanding', 'a reported period is not paid');
  if (l.trueupDue > 0n) fail('TrueUpOutstanding', 'a true-up is not paid');
  const lastEnded = pidAt(BigInt(now)) - 1;
  if (!(lastEnded < (l.firstPeriod ?? 0) || (l.lastAcceptedPeriod !== null && l.lastAcceptedPeriod >= lastEnded))) fail('UnreportedPeriods', 'every ended period must be reported first');
  const q = quote(s, now);
  if (q.pRedeem > big(cmd.maxPricePerUnit)) throw new ChainError('InvalidTerms', `price ${q.pRedeem} exceeds maxPricePerUnit`);
  syncStatus(e, s, now, emit);
  if (q.cRemaining === 0n) {
    // nothing is left of the cap: the series retires instead (SIM:1353-1357)
    retire(e, s, 0n, now, emit);
    return;
  }
  if (q.deposit > U64_MAX) fail('AmountOutOfRange', 'the redemption deposit is out of the u64 range');
  e.debit(signer, s.terms.stablecoinMint, q.deposit);
  s.vaultBalance += q.deposit;
  const N = s.unitsOutstanding;
  const tailEndsAt = now + DEFAULTS.tailSeconds;
  s.redemption = { openedAt: now, pricePerUnit: q.pRedeem, unitsAtRedemption: N, deposit: q.deposit, claimed: 0n, tailCapPerUnit: q.tailCapPerUnit, tailEndsAt };
  s.tail = newTailState(q.tailCapPerUnit);
  emit('RedemptionOpened', { seriesId: s.seriesId, pricePerUnit: str(q.pRedeem), unitsOutstanding: str(N), deposit: str(q.deposit), tailCapPerUnit: str(q.tailCapPerUnit), tailEndsAt });
  setStatus(s, 'Redeemed', emit);
}

/**
 * Stage 1 `claim_redemption` (SIM:1395-1401): NotRedeemed unless the series redeemed and its stored status is
 * Redeemed or Extinguished; HolderNotRegistered for a wallet that is not a registered holder. A holder with nothing
 * left to redeem still settles (a claim of 0 units is allowed).
 */
export function claimRedemption(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimRedemption' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (!s.redemption || (s.status !== 'Redeemed' && s.status !== 'Extinguished')) fail('NotRedeemed', 'the series has not redeemed');
  const p = s.positions.get(signer);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  redeemBody(e, s, p, emit);
}

/**
 * The units a holder's redemption would redeem now: its units less those held for a window ask (never burned). Its
 * auction units not yet delivered count: the redemption delivers them first (S2 amendment M2, so the reads that do not
 * deliver, `claimableRedemption`, do not undercount).
 */
export function redeemableUnits(p: SimPosition): bigint {
  return p.units - p.escrowed;
}

/**
 * The tail catch-up on `units` newly redeemed (Stage 1 S6, SIM:1382-1385): the `[0, lastTailAccWad]` slice of the tail
 * accumulator, floored. The cursor is not reset, so the next tail claim pays the rest.
 */
function tailCatchUp(p: SimPosition, units: bigint): bigint {
  return settleHolderDelta(p.lastTailAccWad, 0n, units);
}

/**
 * A holder's redemption body (Stage 1 `claimRedemptionBody`, SIM:1375-1393), the cross-module contract for
 * `claimRedemption` and the final claim: deliver its auction bid if still pending (`deliverPending`: the refund and the
 * units), settle the holder (HolderNotRegistered), redeem its units not held for a window ask (`units − escrowed`,
 * added to `redeemedUnits`), pay `pending + P_redeem × units + tail catch-up` from the vault, burn those units (reason
 * `redemption`).
 *
 * Events: `BidDelivered` (a pending bid), `PayoutClaimed{burnedUnits: 0}` for the pending payout and the tail catch-up
 * (only when > 0: it is split out of the redemption, whose own claim event carries the principal; S3 D3),
 * `UnitsBurned`, `RedemptionClaimed{units, amount: P_redeem × units}`. This order (the burn before the redemption's own
 * event) is Stage 1's redemption body's, kept as it is; the claim-before-burn order applies to the claim events of S3.
 */
export function redeemBody(e: EngineCore, s: SimSeries, p: SimPosition, emit: Emit): void {
  const r = s.redemption!;
  deliverPending(e, s, p.wallet, emit); // Stage 1 delivers a pending auction allocation first (SIM:1376)
  settleHolder(e, s, p);
  const units = redeemableUnits(p);
  p.redeemedUnits += units;
  const principal = r.pricePerUnit * units;
  const payout = p.pending + tailCatchUp(p, units);
  const amount = payout + principal;
  p.pending = 0n;
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: the deposit covers every unit
  s.vaultBalance -= amount;
  e.credit(p.wallet, s.terms.stablecoinMint, amount);
  if (payout > 0n) {
    s.vaultDistributedNet += payout;
    p.claimedTotal += payout;
    emit('PayoutClaimed', { seriesId: s.seriesId, holder: p.wallet, amount: str(payout), burnedUnits: '0' });
  }
  r.claimed += principal;
  burnUnits(s, p, units, 'redemption', emit);
  emit('RedemptionClaimed', { seriesId: s.seriesId, holder: p.wallet, units: str(units), amount: str(principal) });
}

/** What a holder's redemption would pay now (`redeemBody` without the pending payout), moving nothing: the vault dust read. */
export function claimableRedemption(s: SimSeries, p: SimPosition): bigint {
  if (!s.redemption || (s.status !== 'Redeemed' && s.status !== 'Extinguished')) return 0n;
  const units = redeemableUnits(p);
  return s.redemption.pricePerUnit * units + tailCatchUp(p, units);
}

// ------------------------------------------------------------------ tail
/**
 * Stage 1 `pay` on a Redeemed series (SIM:1158-1172), the money side: the payer is debited the whole tail due as
 * reported (no accrual; `payIn` checks the amount and records the period as paid afterwards, with no `syncStatus`),
 * then `tailReceive` with `N = unitsAtRedemption`: the part above the tail cap goes back to the issuer, the payout
 * fee to the fee collector, `accepted − fee` into the vault on the tail accumulator. The tail never touches the
 * payout vault (`vault.grossReceived`, `vault.feeCollected`); our life-to-date totals count it.
 *
 * Events: `PaymentRefunded{cap}` (refund > 0), `FeeTaken` (fee > 0), `PaymentReceived{source: 'tail', gross:
 * accepted}`, `TailPayout{perUnit: floor(accepted / N), total: accepted}`.
 */
export function payTail(e: EngineCore, s: SimSeries, payer: string, p: SimPeriod, amount: bigint, _now: number, emit: Emit): void {
  const r = s.redemption!;
  const mint = s.terms.stablecoinMint;
  const N = r.unitsAtRedemption;
  if (N === 0n) fail('NoUnitsOutstanding', 'no units were outstanding at redemption');
  e.debit(payer, mint, amount);
  const { state, result } = guardStage1(() => tailReceive(s.tail, amount, N, Number(s.terms.payoutFeeBps)), 'AmountOutOfRange');
  s.tail = state;
  s.vaultBalance += result.accepted - result.fee;
  const { seriesId } = s;
  const periodId = p.periodId;
  if (result.refund > 0n) {
    e.credit(s.issuer, mint, result.refund);
    emit('PaymentRefunded', { seriesId, periodId, amount: str(result.refund), reason: 'cap' });
  }
  if (result.fee > 0n) {
    e.credit(e.state.feeCollector, mint, result.fee);
    emit('FeeTaken', { seriesId, kind: 'payout', amount: str(result.fee), payer });
  }
  s.grossPaidTotal += result.accepted;
  s.feesTotal += result.fee;
  p.paid += result.accepted;
  emit('PaymentReceived', { seriesId, periodId, gross: str(result.accepted), fee: str(result.fee), net: str(result.accepted - result.fee), source: 'tail', paidPerUnitWad: str(s.vault.paidPerUnitWad) });
  emit('TailPayout', { seriesId, periodId, perUnit: str(result.accepted / N), total: str(result.accepted) });
}

/** The tail on `units` since the holder's tail cursor: `floor((tailAccWad − lastTailAccWad) × units / WAD)`. */
function tailSince(s: SimSeries, p: SimPosition, units: bigint): bigint {
  return settleHolderDelta(s.tail.tailAccWad, p.lastTailAccWad, units);
}
/**
 * The tail a holder could take now, without moving its cursor: Stage 1's `claimableTail` view (MercesVault.sol:747-753)
 * and the tail `claim_tail` pays (SIM:1403-1417). It is weighed on the holder's redeemed units or, for a holder that
 * has not redeemed yet, on the units its redemption would redeem (`units − escrowed`), because `claim_tail` redeems
 * them first. 0 before a redemption. `claimTail` pays exactly this, and only `claimTail` pays it (`claimPayout` is the
 * net payout alone).
 */
export function claimableTail(s: SimSeries, p: SimPosition): bigint {
  if (!s.redemption) return 0n;
  return tailSince(s, p, p.redeemedUnits > 0n ? p.redeemedUnits : redeemableUnits(p));
}
/**
 * The tail a holder is owed from its tail cursor on, for the vault dust read: on its redeemed units and on the units
 * its redemption would still redeem. The `[0, lastTailAccWad]` slice on those units is the catch-up
 * `claimableRedemption` counts, so nothing is counted twice. Stage 1 pays exactly this sum through `claim_redemption`
 * then `claim_tail`. It differs from `claimableTail` only for a holder that redeemed some units and has more to
 * redeem: `claim_tail` pays on the redeemed units now, and the rest arrives with the next redemption.
 */
export function tailOwed(s: SimSeries, p: SimPosition): bigint {
  return s.redemption ? tailSince(s, p, p.redeemedUnits + redeemableUnits(p)) : 0n;
}
/**
 * Stage 1 `claim_tail` (SIM:1403-1417). Checks and effects, in order:
 *
 *  1. the series redeemed (NotRedeemed; Stage 1 checks the redemption time only, not the status, so an extinguished
 *     series that redeemed still pays its tail);
 *  2. the signer is a registered holder (HolderNotRegistered);
 *  3. a holder that has redeemed nothing and still has accrual units is redeemed first (`redeemBody`: a pending auction
 *     bid delivered, the pending payout and the tail catch-up in `PayoutClaimed`, `UnitsBurned`, `RedemptionClaimed`);
 *  4. a holder that has still redeemed nothing is refused (NoRedeemedUnits: a late registration with no units, 22#98);
 *  5. the tail on its redeemed units since its tail cursor, `floor((tailAccWad − lastTailAccWad) × redeemedUnits / WAD)`,
 *     is paid from the vault and the cursor moves to `tailAccWad`.
 *
 * Events: the redemption body's when it runs, then `TailClaimed{amount}` (the tail only; 0 included, SPEC's
 * zero-amount rule).
 */
export function claimTail(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimTail' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (!s.redemption) fail('NotRedeemed', 'the series has not redeemed');
  const p = s.positions.get(signer);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  if (p.redeemedUnits === 0n && accrualUnits(s, p) > 0n) redeemBody(e, s, p, emit);
  if (p.redeemedUnits === 0n) fail('NoRedeemedUnits', 'the holder has redeemed no units');
  const amount = tailSince(s, p, p.redeemedUnits);
  p.lastTailAccWad = s.tail.tailAccWad;
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
  s.vaultBalance -= amount;
  s.vaultDistributedNet += amount;
  p.claimedTotal += amount;
  e.credit(p.wallet, s.terms.stablecoinMint, amount);
  emit('TailClaimed', { seriesId: s.seriesId, holder: p.wallet, amount: str(amount) });
}

/** The deprecated per-unit tail paid in base units (`RedemptionState.tailPaidPerUnit`), from Stage 1's WAD figure. */
export function tailPaidPerUnit(s: SimSeries): bigint {
  return s.tail.tailPaidPerUnitWad / WAD;
}

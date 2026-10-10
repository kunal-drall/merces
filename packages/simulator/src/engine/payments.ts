import { ChainError, type Command } from '@merces/domain';
import { DAY, U64_MAX, lateAccrual, periodEnd, periodOf, settlementYear, vaultReceiveGross, type ReceiveResult } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { fail, guardStage1 } from './errors.ts';
import { burnUnits, heldUnits, settleHolder } from './holders.ts';
import { ledgerClock, liveCapPerUnit, mintFinalized, periodIdOf, retire, statusParams } from './ledger.ts';
import { payTail, takeTail } from './redemption.ts';
import { periodRecord, syncReleaseBlock, syncStatus } from './status.ts';
import { takeFinal } from './terminal.ts';

/**
 * The payout vault, payments, claims and burns on Stage 1's vault (SPEC v1.1 §6.3; Stage 1 simulator SIM:457-469,
 * 624-636, 1151-1185, 1268-1282), through `@merces/math`.
 */

/** What a vault receipt is, for the events: the period it pays, the canonical source and the wallet debited. */
interface Receipt {
  periodId: string | null;
  source: 'payIn' | 'split';
  payer: string;
  /** `payIn` only: the due recomputed at payment time (the open due plus the lateness accrual) and that accrual */
  due?: { paymentDue: bigint; accrual: bigint };
}

/**
 * Stage 1 `vault_receive_gross(G, source, period_for_year)` (SIM:457-469) on gross `G` the caller already debited:
 * `vaultReceiveGross` with `N = unitsOutstanding`, the cap read live (`liveCapPerUnit`, so an amendment applies at once),
 * the payout fee and the settlement year of `anchorTs`. The cap refund goes to the **issuer**, the fee to the fee
 * collector, `accepted − fee` to the vault. Retires the series when the cap is met (`retire`, SIM:445-454).
 *
 * Events: `PaymentRefunded{cap}` (refund > 0), `FeeTaken` (fee > 0), `PaymentReceived{gross: accepted, fee, net,
 * paidPerUnitWad}`, then retirement's `StatusChanged` and `SeriesRetired`.
 */
export function vaultReceive(e: EngineCore, s: SimSeries, gross: bigint, anchorTs: bigint, receipt: Receipt, now: number, emit: Emit): ReceiveResult {
  if (!mintFinalized(s)) fail('MintNotFinalized', 'the raise is still processing its bids');
  // checked here: `vaultReceiveGross` throws a plain Error for it
  const N = s.unitsOutstanding;
  if (N === 0n) fail('NoUnitsOutstanding', 'the series has no units outstanding');
  const year = settlementYear(anchorTs, BigInt(s.settledAt!));
  const { state, result } = guardStage1(() => vaultReceiveGross(s.vault, gross, N, liveCapPerUnit(s), Number(s.terms.payoutFeeBps), year), 'AmountOutOfRange');
  s.vault = state;
  s.vaultBalance += result.accepted - result.fee;
  const mint = s.terms.stablecoinMint;
  const { seriesId } = s;
  if (result.refund > 0n) {
    e.credit(s.issuer, mint, result.refund);
    emit('PaymentRefunded', { seriesId, periodId: receipt.periodId, amount: str(result.refund), reason: 'cap' });
  }
  if (result.fee > 0n) {
    e.credit(e.state.feeCollector, mint, result.fee);
    emit('FeeTaken', { seriesId, kind: 'payout', amount: str(result.fee), payer: receipt.payer });
  }
  // our life-to-date totals (the API vault totals; the tail adds to them too)
  s.grossPaidTotal += result.accepted;
  s.feesTotal += result.fee;
  emit('PaymentReceived', {
    seriesId, periodId: receipt.periodId, gross: str(result.accepted), fee: str(result.fee), net: str(result.netAdded), source: receipt.source, paidPerUnitWad: str(s.vault.paidPerUnitWad),
    ...(receipt.due ? { paymentDue: str(receipt.due.paymentDue), accrual: str(receipt.due.accrual) } : {}),
  });
  if (result.retired) {
    retire(e, s, result.refund, now, emit);
    // nothing more is owed once the cap is met: the lateness block ends with the obligation (a split receipt has no
    // sync point after it, so the release events are settled here)
    syncReleaseBlock(s, now, emit);
  }
  return result;
}

// ------------------------------------------------------------------ paying in
/**
 * Stage 1 `pay` (SIM:1151-1185): whoever signs pays the open due (no issuer check). Checks and effects, in order:
 *
 *  1. the mint is final (MintNotFinalized), something is due (NothingDue);
 *  2. ours: `cmd.periodId` names the open due period (InvalidTerms; the live adapter checks it offchain);
 *  3. a Redeemed series pays its tail as reported (`payTail`, Stage 1 `tailReceive`), with no accrual and no sync after it;
 *  4. otherwise `total = openDueAmount + lateAccrual(...)` at `now` (u64, AmountOutOfRange); ours: `amount` must be
 *     exactly `total` (InvalidTerms; Stage 1's `pay` takes no amount);
 *  5. debit the payer (InsufficientEscrow), `vaultReceive` with the year anchored on the period's report deadline
 *     (`periodEnd + reportDueDays`, SIM:1176), record `accrualPaid`/`paidAt`, `lastPaidPeriod`, clear the open due;
 *  6. `syncStatus`.
 */
export function payIn(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'payIn' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const l = s.ledger;
  if (!mintFinalized(s)) fail('MintNotFinalized', 'the raise is still processing its bids');
  if (l.openDueAmount === 0n || l.openDuePeriod === null) fail('NothingDue', 'nothing is due');
  const pid = l.openDuePeriod;
  const periodId = periodIdOf(pid);
  if (cmd.periodId !== periodId) throw new ChainError('InvalidTerms', `the open due is for ${periodId}`);
  const amount = big(cmd.amount);
  const p = periodRecord(s, periodId);
  if (s.status === 'Redeemed') {
    // the tail due as reported, no accrual (SIM:1157-1172): the payer pays all of it, `tailReceive` applies the tail
    // cap and the excess goes back to the issuer (`payTail`)
    const due = l.openDueAmount;
    if (amount !== due) throw new ChainError('InvalidTerms', `payIn must equal the amount due ${due}`);
    payTail(e, s, signer, p, due, now, emit);
    settle(s, p.periodId, now);
    return; // Stage 1 does not sync after a tail payment
  }
  const accrual = lateAccrual(pid, l.openDueAmount, ledgerClock(s), BigInt(now), statusParams(s));
  const total = l.openDueAmount + accrual;
  if (total > U64_MAX) fail('AmountOutOfRange', 'the due with its accrual is out of the u64 range');
  if (amount !== total) throw new ChainError('InvalidTerms', `payIn must equal the amount due ${total}`);
  e.debit(signer, s.terms.stablecoinMint, total);
  const anchor = periodEnd(pid) + BigInt(statusParams(s).reportDueDays) * DAY;
  const r = vaultReceive(e, s, total, anchor, { periodId, source: 'payIn', payer: signer, due: { paymentDue: total, accrual } }, now, emit);
  // the period as the reads show it once paid: the due recomputed at payment time; `paid` is what the vault accepted
  // (a cap refund is not part of it, A-C6-1)
  p.paymentDue = total;
  p.accrualPaid = accrual;
  p.paid += r.accepted;
  settle(s, periodId, now);
  syncStatus(e, s, now, emit);
}
/** The open due period is paid: `paidAt`, `lastPaidPeriod`, the open due cleared (SIM:1177-1180). */
function settle(s: SimSeries, periodId: string, now: number): void {
  const p = periodRecord(s, periodId);
  p.settled = true;
  p.paidAt = now;
  const l = s.ledger;
  l.lastPaidPeriod = p.pid;
  l.openDuePeriod = null;
  l.openDueAmount = 0n;
}

/**
 * A tier-1 split receipt: the router's income share enters the vault like Stage 1's routed income (`route_income`,
 * SIM:1240-1266), year from `now` (SIM:1261), refund to the issuer. S5 moves the router onto Stage 1's.
 */
export function postSplitReceipt(e: EngineCore, router: string, cmd: Extract<Command, { kind: 'postSplitReceipt' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.splitRouter !== router) throw new ChainError('Unauthorized', 'router not registered for this series');
  if (s.phase !== 'Settled' || TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series cannot receive split income');
  const amount = big(cmd.amount);
  const periodId = periodOf(now).id;
  e.debit(router, s.terms.stablecoinMint, amount);
  const { accepted } = vaultReceive(e, s, amount, BigInt(now), { periodId, source: 'split', payer: router }, now, emit);
  periodRecord(s, periodId).splitReceived += accepted;
  emit('SplitReceipt', { seriesId: s.seriesId, periodId, amount: str(accepted), router });
}

// ------------------------------------------------------------------ payouts, burns
/**
 * Stage 1 `claim` (SIM:1268-1282), with the tail (`claim_tail`) and the final pool (`claim_final`) in the same command
 * until S3 makes it Stage 1's `claim` (the separate `claimTail` and `claimFinal` exist already). A holder with no
 * registration is refused (HolderNotRegistered). Settle the holder on the vault cursor, pay `pending` + tail + final
 * (`takeFinal`, which on a redeemed series runs the redemption body first). A Retired or Extinguished series burns the
 * holder's balance (`heldUnits`: Stage 1 burns `unitsOf`, which excludes the ask escrow and the auction units not yet
 * delivered: SIM:1275, 1470), even when nothing is paid; the escrowed units come back when the window clears,
 * undelivered ones when delivered, and burn at the next claim (on an extinguished series the final claim delivers
 * first: `takeFinal`). `PayoutClaimed.burnedUnits` names the units the claim burns. Nothing to pay and nothing to burn
 * is a successful no-op with no events (S3 moves this command to Stage 1's zero-amount rule).
 */
export function claimPayout(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimPayout' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const p = s.positions.get(signer);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleHolder(e, s, p);
  let amount = p.pending;
  p.pending = 0n;
  amount += takeTail(e, s, p);
  amount += takeFinal(e, s, p, emit);
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
  // `claim` and `claim_final` burn the holder's balance (SIM:1275, 1470): units held for a window ask come back when
  // the window clears (WP8); a Retired holder's undelivered auction units burn once delivered
  const burned = s.status === 'Retired' ? heldUnits(s, p) : s.status === 'Extinguished' ? p.units - p.escrowed : 0n;
  if (amount > 0n) {
    s.vaultBalance -= amount;
    s.vaultDistributedNet += amount;
    p.claimedTotal += amount;
    e.credit(signer, s.terms.stablecoinMint, amount);
    emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(amount), burnedUnits: str(burned) });
  }
  burnUnits(s, p, burned, s.status === 'Retired' ? 'cap' : 'extinguishment', emit);
}
/**
 * Stage 1 `burn_retired` (SIM:624-636), permissionless. Checks and effects, in order:
 *
 *  1. the stored status is Retired (TerminalStatus; an Extinguished series is refused, since burning before
 *     `claimFinal` would zero the holder's final-pool weight);
 *  2. a wallet whose balance is 0 emits `UnitsBurned{units: 0}` and nothing else, before any registration check, so a
 *     wallet that never held units is not refused (21#51; Stage 1's zero-amount rule);
 *  3. otherwise the holder is settled (HolderNotRegistered; its `pending` stays claimable) and its balance burns
 *     (`UnitsBurned{reason: cap}`).
 *
 * The balance is Stage 1's `unitsOf` (`heldUnits`, SIM:627): the units held for a window ask and the auction units not
 * yet delivered are not burned; they burn once the window returns them or they are delivered.
 */
export function burnRetired(e: EngineCore, cmd: Extract<Command, { kind: 'burnRetired' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Retired') fail('TerminalStatus', 'units are burned only on a Retired series');
  const p = s.positions.get(cmd.holder);
  const balance = p ? heldUnits(s, p) : 0n;
  if (!p || balance === 0n) {
    emit('UnitsBurned', { seriesId: s.seriesId, holder: cmd.holder, units: '0', reason: 'cap' });
    return;
  }
  settleHolder(e, s, p);
  burnUnits(s, p, balance, 'cap', emit);
}
/**
 * Stage 1 `burn_retired` (SIM:624-636), for each listed holder: the stored status must be Retired (TerminalStatus; an
 * Extinguished series is refused, since burning before `claim_final` would zero the holder's final-pool weight). A
 * holder with no balance is a no-op; otherwise settle it (its `pending` stays claimable) and burn its balance. The
 * balance excludes the units held for a window ask and the auction units not yet delivered (Stage 1 `unitsOf`,
 * SIM:627, `heldUnits`): they burn once the window returns them or they are delivered. `burnRetired` replaces it (S3).
 */
export function crankBurn(e: EngineCore, cmd: Extract<Command, { kind: 'crankBurn' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Retired') fail('TerminalStatus', 'units are burned by the crank only on a Retired series');
  for (const h of cmd.holders) {
    const p = s.positions.get(h);
    const balance = p ? heldUnits(s, p) : 0n;
    if (!p || balance === 0n) continue;
    settleHolder(e, s, p);
    burnUnits(s, p, balance, 'cap', emit);
  }
}

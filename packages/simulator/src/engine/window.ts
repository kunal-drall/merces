import { orderCommitment, type Command } from '@merces/domain';
import { computeFills, finalizeWindow as finish, findWindowClearingPrice, isOrderValid, tallyOrders, toPid, fromPid, pidAt, settleHolderDelta, type WindowOrder } from '@merces/math';
import type { SimSeries, SimTransferWindow, SimWindowOrder } from '../state.ts';
import { personalityLimits } from '../addresses.ts';
import { TERMINAL, big, str, u64, type EngineCore, type Emit } from './core.ts';
import { requireSealedBid } from './auction.ts';
import { fail } from './errors.ts';
import { heldUnits, position, registerHolder, settleHolder } from './holders.ts';
import { derivedStatus, mintFinalized } from './ledger.ts';
import { syncStatus } from './status.ts';

export function window(s: SimSeries, id: number): SimTransferWindow {
  const w = s.transferWindows[id];
  if (!w) fail('WindowNotOpen');
  return w;
}
export function asWindowOrder(o: SimWindowOrder): WindowOrder {
  return { owner: o.wallet, side: o.side === 'buy' ? 0 : 1, escrow: o.side === 'buy' ? o.deposit : o.escrowedUnits,
    revealed: o.revealed !== null, valid: o.valid, price: o.revealed?.pricePerUnit ?? 0n, quantity: o.revealed?.quantity ?? 0n, revealIndex: o.revealIndex };
}
function orders(w: SimTransferWindow): WindowOrder[] { return [...w.orders.values()].map(asWindowOrder); }

/** SPEC §7, MercesWindow.openWindow/window.rs: paid previous quarter, live status, mint and lockup gates. */
export function openWindow(e: EngineCore, cmd: Extract<Command, { kind: 'openWindow' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  requireSealedBid(s);
  if (!e.state.windowsEnabled) fail('WindowsDisabled');
  if (s.phase !== 'Settled') fail('RaiseNotSettled');
  if (!mintFinalized(s)) fail('MintNotFinalized');
  const status = derivedStatus(s, now);
  if (status !== 'OnTime' && status !== 'InGrace') fail('WindowNotEligible');
  if (now < s.settledAt! + s.terms.lockupSeconds) fail('LockupActive');
  const period = toPid(cmd.periodId);
  if (s.ledger.lastPaidPeriod === null || s.ledger.lastPaidPeriod < period || period !== pidAt(BigInt(now)) - 1) fail('WindowNotEligible');
  if (s.transferWindows.some((w) => w.state !== 'Done' || w.period === period)) fail('WindowOpen');
  syncStatus(e, s, now, emit);
  const windowId = s.transferWindows.length;
  const commitEndsAt = now + s.terms.windowCommitDuration, revealEndsAt = commitEndsAt + s.terms.windowRevealDuration;
  s.transferWindows.push({ windowId, period, state: 'Commit', commitEndsAt, revealEndsAt, cleared: false, clearingPrice: null,
    proposal: null, tallyRound: 0, roundRejected: false, tally: tallyOrders([], null), talliedCount: 0, clearing: null,
    accAtClear: 0n, escrowStable: 0n, escrowUnits: 0n, orders: new Map() });
  emit('TransferWindowOpened', { seriesId: s.seriesId, windowId, periodId: cmd.periodId, commitEndsAt, revealEndsAt });
}
/** Compatibility entry point; immutable series durations and the same eligibility guards apply. */
export function openTransferWindow(e: EngineCore, cmd: Extract<Command, { kind: 'openTransferWindow' }>, now: number, emit: Emit): void {
  openWindow(e, { kind: 'openWindow', seriesId: cmd.seriesId, periodId: fromPid(pidAt(BigInt(now)) - 1) }, now, emit);
}

export function commitWindowOrder(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'commitWindowOrder' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (w.state !== 'Commit' || now >= w.commitEndsAt) fail('WindowNotOpen');
  if (w.orders.has(signer)) fail('OrderExists');
  const deposit = u64(cmd.deposit), units = u64(cmd.units);
  if (cmd.side === 'buy') {
    e.requireAllowlisted(signer);
    if (deposit === 0n) fail('ZeroEscrow');
    e.debit(signer, s.terms.stablecoinMint, deposit);
    w.escrowStable += deposit;
  } else {
    const p = s.positions.get(signer);
    if (!p || units === 0n || heldUnits(s, p) < units) fail('InsufficientUnits');
    settleHolder(e, s, p);
    p.escrowed += units;
    w.escrowUnits += units;
  }
  const o: SimWindowOrder = { wallet: signer, side: cmd.side, commitment: cmd.commitment, deposit: cmd.side === 'buy' ? deposit : 0n,
    escrowedUnits: cmd.side === 'sell' ? units : 0n, order: w.orders.size, revealed: null, valid: false, revealIndex: -1, talliedRound: 0,
    processed: false, delivered: false, fill: 0n, fee: 0n, pendingUnits: 0n, pendingStable: 0n, cancelled: false };
  w.orders.set(signer, o);
  emit('WindowOrderCommitted', { seriesId: s.seriesId, windowId: w.windowId, owner: signer, side: o.side, commitment: o.commitment, escrow: str(o.side === 'buy' ? deposit : units) });
}
export function revealWindowOrder(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'revealWindowOrder' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (w.state !== 'Commit' && w.state !== 'Reveal') fail('WindowNotOpen');
  if (now < w.commitEndsAt || now >= w.revealEndsAt) fail('RevealPhaseClosed');
  const o = w.orders.get(signer);
  if (!o || o.side !== cmd.side) fail('BidNotFound');
  if (o.revealed) fail('AlreadyRevealed');
  const price = u64(cmd.pricePerUnit), quantity = u64(cmd.quantity);
  if (orderCommitment({ wallet: signer, pricePerUnit: price, quantity, salt: cmd.salt }) !== o.commitment) fail('CommitmentMismatch');
  o.revealed = { pricePerUnit: price, quantity };
  o.revealIndex = [...w.orders.values()].filter((x) => x.side === o.side && x.revealed !== null).length - 1;
  o.valid = isOrderValid(o.side === 'buy' ? 0 : 1, price, quantity, o.side === 'buy' ? o.deposit : o.escrowedUnits,
    s.positions.has(signer) ? heldUnits(s, s.positions.get(signer)!) : 0n, { unitsOutstanding: s.unitsOutstanding, walletCapBps: Number(s.terms.walletCapBps), windowFeeBps: s.terms.windowFeeBps });
  w.state = 'Reveal';
  emit('WindowOrderRevealed', { seriesId: s.seriesId, windowId: w.windowId, owner: signer, pricePerUnit: str(price), quantity: str(quantity), valid: o.valid, revealIndex: o.revealIndex });
}
export function beginWindowSettlement(e: EngineCore, cmd: Extract<Command, { kind: 'beginWindowSettlement' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (!['Commit', 'Reveal', 'Settling'].includes(w.state)) fail('WindowNotOpen');
  if (now < w.revealEndsAt) fail('SettlementNotReady');
  if (w.tallyRound !== 0 && !w.roundRejected) fail('TallyInProgress');
  w.proposal = cmd.clearingPrice === null ? null : u64(cmd.clearingPrice);
  w.tallyRound++; w.roundRejected = false; w.state = 'Settling'; w.talliedCount = 0; w.tally = tallyOrders([], w.proposal);
  emit('WindowSettlementProposed', { seriesId: s.seriesId, windowId: w.windowId, clearingPrice: cmd.clearingPrice, round: w.tallyRound });
}
export function tallyWindow(e: EngineCore, cmd: Extract<Command, { kind: 'tallyWindow' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (w.state !== 'Settling' || w.roundRejected) fail('WindowNotOpen');
  const page = [...w.orders.values()].filter((o) => o.revealed && o.talliedRound !== w.tallyRound).sort((a, b) => a.revealIndex - b.revealIndex)
    .slice(0, Math.min(cmd.maxOrders, personalityLimits(e.state.config.personality).tallyPageMax));
  for (const o of page) o.talliedRound = w.tallyRound;
  const tallied = [...w.orders.values()].filter((o) => o.revealed && o.talliedRound === w.tallyRound);
  w.talliedCount = tallied.length;
  w.tally = tallyOrders(tallied.map(asWindowOrder), w.proposal);
  emit('WindowOrdersTallied', { seriesId: s.seriesId, windowId: w.windowId, round: w.tallyRound, talliedCount: w.talliedCount });
}
export function finalizeWindowSettlement(e: EngineCore, cmd: Extract<Command, { kind: 'finalizeWindow' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (w.state !== 'Settling' || w.roundRejected) fail('WindowNotOpen');
  if (w.talliedCount !== [...w.orders.values()].filter((o) => o.revealed).length) fail('TallyIncomplete');
  const result = TERMINAL.has(s.status) ? { kind: 'nomatch' as const } : finish(w.tally, w.proposal);
  if (result.kind === 'rejected') {
    w.roundRejected = true;
    emit('WindowSettlementRejected', { seriesId: s.seriesId, windowId: w.windowId, round: w.tallyRound, reason: result.reason });
    return;
  }
  w.clearing = result.kind === 'settled' ? result.clearing : null;
  w.clearingPrice = w.clearing?.clearingPrice ?? null;
  w.accAtClear = s.vault.netAccWad;
  w.state = w.orders.size === 0 ? 'Done' : result.kind === 'settled' ? 'Settled' : 'NoMatch';
  w.cleared = w.state === 'Done';
  emit('TransferWindowCleared', { seriesId: s.seriesId, windowId: w.windowId, clearingPrice: str(w.clearingPrice ?? 0n), unitsTransferred: str(w.clearing?.matchedUnits ?? 0n), done: w.state === 'Done' });
}

/** Process revealed bids before asks, each side in reveal order; delivery is an independent retryable transaction. */
export function processOrder(e: EngineCore, cmd: Extract<Command, { kind: 'processOrder' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  const o = w.orders.get(cmd.owner);
  if (!o) fail('BidNotFound');
  if (o.processed) fail('AlreadyProcessed');
  if (w.state !== 'Settled' && w.state !== 'NoMatch') fail('WindowNotOpen');
  const list = [...w.orders.values()];
  if (w.clearing && o.revealed) {
    if (o.side === 'sell' && list.some((b) => b.side === 'buy' && b.revealed && !b.processed)) fail('BidsNotProcessed');
    if (list.some((x) => x.side === o.side && x.revealed && !x.processed && x.revealIndex < o.revealIndex)) fail('OutOfOrder');
  }
  let fill = 0n, fee = 0n, refund = o.side === 'buy' ? o.deposit : o.escrowedUnits;
  if (w.clearing) {
    // Bid cancellation is frozen when that bid is processed; later allowlist changes cannot rewrite it.
    const fills = computeFills(orders(w), w.clearing, s.terms.windowFeeBps, (owner) => {
      const bid = w.orders.get(owner)!;
      return bid.processed ? !bid.cancelled : e.state.allowlist.has(owner);
    });
    const f = fills[list.indexOf(o)]!;
    fill = f.fill; fee = f.fee; refund = f.refund; o.cancelled = f.cancelled;
  }
  o.fill = fill; o.fee = fee;
  const p = position(s, o.wallet);
  if (o.side === 'buy') {
    o.pendingUnits = fill; o.pendingStable = refund;
    if (fill > 0n) {
      registerHolder(s, p, emit);
      settleHolder(e, s, p);
      p.pending += settleHolderDelta(s.vault.netAccWad, w.accAtClear, fill);
      p.units += fill;
    }
    w.escrowStable -= fee;
    if (fee > 0n) {
      e.credit(e.state.feeCollector, s.terms.stablecoinMint, fee);
      emit('FeeTaken', { seriesId: s.seriesId, payer: o.wallet, kind: 'window', amount: str(fee) });
    }
  } else {
    settleHolder(e, s, p);
    if (w.clearing) p.pending += settleHolderDelta(s.vault.netAccWad, w.accAtClear, refund);
    p.escrowed -= o.escrowedUnits;
    p.units -= fill;
    o.pendingUnits = refund; o.pendingStable = (w.clearingPrice ?? 0n) * fill;
  }
  o.processed = true;
  if (list.every((x) => x.processed)) { w.state = 'Done'; w.cleared = true; }
  emit('WindowOrderProcessed', { seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet, side: o.side, fill: str(fill), pricePerUnit: str(w.clearingPrice ?? 0n), fee: str(fee), refund: str(refund), pendingUnits: str(o.pendingUnits), pendingStable: str(o.pendingStable), cancelled: o.cancelled, done: w.state === 'Done' });
}
export function deliverOrder(e: EngineCore, cmd: Extract<Command, { kind: 'deliverOrder' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId), o = w.orders.get(cmd.owner);
  if (!o) fail('BidNotFound');
  if (!o.processed) fail('NotProcessed');
  if (o.delivered) fail('AlreadyDelivered');
  w.escrowUnits -= o.pendingUnits; w.escrowStable -= o.pendingStable;
  o.delivered = true;
  e.credit(o.wallet, s.terms.stablecoinMint, o.pendingStable);
  emit('WindowOrderDelivered', { seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet, units: str(o.pendingUnits), amount: str(o.pendingStable) });
}
/** Legacy simulator convenience: executes the same steps. Keepers and the public planner use explicit commands. */
export function clearTransferWindow(e: EngineCore, cmd: Extract<Command, { kind: 'clearTransferWindow' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId), w = window(s, cmd.windowId);
  if (w.state === 'Done') fail('AlreadyProcessed');
  if (w.tallyRound === 0 || w.roundRejected) beginWindowSettlement(e, { kind: 'beginWindowSettlement', seriesId: s.seriesId, windowId: w.windowId, clearingPrice: findWindowClearingPrice(orders(w))?.toString() ?? null }, now, emit);
  while (w.talliedCount < [...w.orders.values()].filter((o) => o.revealed).length) tallyWindow(e, { kind: 'tallyWindow', seriesId: s.seriesId, windowId: w.windowId, maxOrders: 200 }, emit);
  finalizeWindowSettlement(e, { kind: 'finalizeWindow', seriesId: s.seriesId, windowId: w.windowId }, emit);
  const list = [...w.orders.values()].sort((a, b) => a.side === b.side ? a.revealIndex - b.revealIndex : a.side === 'buy' ? -1 : 1);
  for (const o of list) processOrder(e, { kind: 'processOrder', seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet }, emit);
  for (const o of list) deliverOrder(e, { kind: 'deliverOrder', seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet }, emit);
}

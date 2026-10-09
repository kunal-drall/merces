import { ChainError, orderCommitment, type Command } from '@merces/domain';
import { interim } from '@merces/math';
import type { SimSeries, SimTransferWindow } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { position, setUnits } from './holders.ts';

// ------------------------------------------------------------------ transfer windows (built, switched off at the service layer)
export function openTransferWindow(e: EngineCore, cmd: Extract<Command, { kind: 'openTransferWindow' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  // curve units trade freely on the DEX pool after graduation (A-CURVE-2): no window, so no window cap or allowlist
  if (s.curve) throw new ChainError('WrongPhase', 'curve units trade on the DEX pool, not in transfer windows');
  if (s.phase !== 'Settled' || TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series cannot open a window');
  if (now < s.settledAt! + s.terms.lockupSeconds) throw new ChainError('TooEarly', 'lockup has not ended');
  if (s.transferWindows.some((w) => !w.cleared)) throw new ChainError('Duplicate', 'a window is already open');
  if (cmd.commitEndsAt <= now || cmd.revealEndsAt <= cmd.commitEndsAt) throw new ChainError('InvalidTerms', 'bad window timings');
  const windowId = s.transferWindows.length;
  s.transferWindows.push({ windowId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt, cleared: false, clearingPrice: null, orders: new Map() });
  emit('TransferWindowOpened', { seriesId: s.seriesId, windowId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt });
}
export function window(s: SimSeries, id: number): SimTransferWindow {
  const w = s.transferWindows[id];
  if (!w) throw new ChainError('NotFound', 'no such window');
  return w;
}
export function commitWindowOrder(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'commitWindowOrder' }>, now: number, _emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const w = window(s, cmd.windowId);
  if (w.cleared || now >= w.commitEndsAt) throw new ChainError('WrongPhase', 'commit phase over');
  if (w.orders.has(signer)) throw new ChainError('Duplicate', 'one order per wallet per window');
  const deposit = big(cmd.deposit);
  const units = big(cmd.units);
  if (cmd.side === 'buy') {
    e.requireAllowlisted(signer); // removed wallets may still SELL (C10: never strand value)
    if (deposit <= 0n) throw new ChainError('InvalidTerms', 'deposit required');
    e.debit(signer, s.terms.stablecoinMint, deposit);
    w.orders.set(signer, { wallet: signer, side: 'buy', commitment: cmd.commitment, deposit, escrowedUnits: 0n, order: w.orders.size, revealed: null });
  } else {
    const p = s.positions.get(signer);
    if (!p || p.units - p.escrowed < units || units <= 0n) throw new ChainError('InsufficientFunds', 'not enough free units');
    p.escrowed += units; // units stay in the position (payouts keep accruing); they just cannot be sold twice
    w.orders.set(signer, { wallet: signer, side: 'sell', commitment: cmd.commitment, deposit: 0n, escrowedUnits: units, order: w.orders.size, revealed: null });
  }
}
export function revealWindowOrder(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'revealWindowOrder' }>, now: number, _emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const w = window(s, cmd.windowId);
  if (w.cleared || now < w.commitEndsAt || now >= w.revealEndsAt) throw new ChainError('WrongPhase', 'not in the reveal phase');
  const o = w.orders.get(signer);
  if (!o || o.side !== cmd.side) throw new ChainError('NotFound', 'no matching order');
  if (o.revealed) throw new ChainError('Duplicate', 'already revealed');
  const price = big(cmd.pricePerUnit);
  const qty = big(cmd.quantity);
  const expected = orderCommitment({ seriesId: s.seriesId, windowId: w.windowId, wallet: signer, side: cmd.side, pricePerUnit: price, quantity: qty, salt: cmd.salt });
  if (expected !== o.commitment) throw new ChainError('InvalidCommitment', 'reveal mismatch');
  if (o.side === 'buy' && price * qty > o.deposit) throw new ChainError('InsufficientFunds', 'deposit too small');
  if (o.side === 'sell' && qty > o.escrowedUnits) throw new ChainError('InsufficientFunds', 'more than escrowed');
  o.revealed = { pricePerUnit: price, quantity: qty };
}
export function clearTransferWindow(e: EngineCore, cmd: Extract<Command, { kind: 'clearTransferWindow' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const w = window(s, cmd.windowId);
  if (w.cleared) throw new ChainError('Duplicate', 'already cleared');
  if (now < w.revealEndsAt) throw new ChainError('TooEarly', 'reveal phase not over');
  const mint = s.terms.stablecoinMint;
  const buys = [...w.orders.values()].filter((o) => o.side === 'buy' && o.revealed).sort((a, b) => (a.revealed!.pricePerUnit === b.revealed!.pricePerUnit ? a.order - b.order : a.revealed!.pricePerUnit > b.revealed!.pricePerUnit ? -1 : 1));
  const sells = [...w.orders.values()].filter((o) => o.side === 'sell' && o.revealed).sort((a, b) => (a.revealed!.pricePerUnit === b.revealed!.pricePerUnit ? a.order - b.order : a.revealed!.pricePerUnit < b.revealed!.pricePerUnit ? -1 : 1));
  const cap = interim.walletCapUnits(s.unitsOutstanding, s.terms.walletCapBps);
  const fills: { buyer: string; seller: string; units: bigint }[] = [];
  let clearing = 0n;
  let bi = 0;
  let si = 0;
  const buyLeft = buys.map((b) => b.revealed!.quantity);
  const sellLeft = sells.map((x) => x.revealed!.quantity);
  // escrowed units stay in the position, so a redemption, retirement or extinguishment during the window may
  // already have burned them: a terminal series only refunds deposits and releases escrow
  while (!TERMINAL.has(s.status) && bi < buys.length && si < sells.length) {
    const b = buys[bi]!;
    const x = sells[si]!;
    if (b.revealed!.pricePerUnit < x.revealed!.pricePerUnit) break;
    const held = (s.positions.get(b.wallet)?.units ?? 0n) + fills.filter((f) => f.buyer === b.wallet).reduce((a, f) => a + f.units, 0n);
    const room = cap > held ? cap - held : 0n;
    const units = interim.min(interim.min(buyLeft[bi]!, sellLeft[si]!), room);
    if (units === 0n) {
      bi++;
      continue;
    }
    const sold = fills.filter((f) => f.seller === x.wallet).reduce((a, f) => a + f.units, 0n);
    if ((s.positions.get(x.wallet)?.units ?? 0n) - sold < units) {
      // never sell units the seller no longer holds; its order is skipped and the escrow released below
      si++;
      continue;
    }
    fills.push({ buyer: b.wallet, seller: x.wallet, units });
    clearing = b.revealed!.pricePerUnit;
    buyLeft[bi] = buyLeft[bi]! - units;
    sellLeft[si] = sellLeft[si]! - units;
    if (buyLeft[bi] === 0n) bi++;
    if (sellLeft[si] === 0n) si++;
  }
  let transferred = 0n;
  for (const f of fills) {
    const buyer = position(s, f.buyer);
    const seller = position(s, f.seller);
    const sellOrder = w.orders.get(f.seller)!;
    sellOrder.escrowedUnits -= f.units;
    seller.escrowed -= f.units;
    setUnits(s, seller, seller.units - f.units);
    setUnits(s, buyer, buyer.units + f.units);
    const amount = f.units * clearing;
    const buyOrder = w.orders.get(f.buyer)!;
    buyOrder.deposit -= amount;
    e.credit(f.seller, mint, amount);
    transferred += f.units;
    emit('UnitsTransferred', { seriesId: s.seriesId, from: f.seller, to: f.buyer, units: str(f.units), windowId: w.windowId });
  }
  // refunds: leftover deposits and un-sold escrowed units
  for (const o of w.orders.values()) {
    if (o.side === 'buy' && o.deposit > 0n) {
      e.credit(o.wallet, mint, o.deposit);
      o.deposit = 0n;
    }
    if (o.side === 'sell' && o.escrowedUnits > 0n) {
      position(s, o.wallet).escrowed -= o.escrowedUnits; // release the hold; the units never left the position
      o.escrowedUnits = 0n;
    }
  }
  w.cleared = true;
  w.clearingPrice = transferred > 0n ? clearing : null;
  emit('TransferWindowCleared', { seriesId: s.seriesId, windowId: w.windowId, clearingPrice: str(transferred > 0n ? clearing : 0n), unitsTransferred: str(transferred) });
}

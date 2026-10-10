import { ChainError, bidCommitment, type Command } from '@merces/domain';
import { bpsOf, capPerUnit, interim } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { position, registerHolder, setUnits } from './holders.ts';
import { pidAtTime } from './ledger.ts';

// ------------------------------------------------------------------ auction
export function openRaise(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'openRaise' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Draft') throw new ChainError('WrongPhase', `series is ${s.phase}`);
  if (s.terms.raiseStyle !== 'sealed') throw new ChainError('WrongPhase', 'curve-mode series do not run a sealed-bid raise');
  if (e.state.newRaisesPaused) throw new ChainError('Paused', 'new raises are paused');
  if (cmd.commitEndsAt <= now || cmd.revealEndsAt <= cmd.commitEndsAt) throw new ChainError('InvalidTerms', 'bad auction timings');
  s.phase = 'Open';
  s.openedAt = now;
  s.commitEndsAt = cmd.commitEndsAt;
  s.revealEndsAt = cmd.revealEndsAt;
  emit('RaiseOpened', { seriesId: s.seriesId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt });
}
export function cancelRaise(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'cancelRaise' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Open' && s.phase !== 'Draft') throw new ChainError('WrongPhase', `series is ${s.phase}`);
  if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', `series is ${s.status}`);
  if (s.bids.size > 0) throw new ChainError('TooLate', 'bids exist; the raise can no longer be cancelled');
  // curve buyers already hold units backed by the treasury: cancelling would strand them (A-CURVE-3)
  if (s.curve && s.unitsOutstanding > 0n) throw new ChainError('TooLate', 'curve units exist; the raise can no longer be cancelled');
  s.phase = 'Cancelled';
  emit('RaiseCancelled', { seriesId: s.seriesId });
}
/** The reveal phase is time-derived: commitEndsAt ≤ now < revealEndsAt. */
export function auctionPhase(s: SimSeries, now: number): 'Draft' | 'Open' | 'Reveal' | 'SettleDue' | 'Settled' | 'Failed' | 'Cancelled' {
  if (s.phase !== 'Open') return s.phase;
  if (now < s.commitEndsAt!) return 'Open';
  if (now < s.revealEndsAt!) return 'Reveal';
  return 'SettleDue';
}
export function commitBid(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'commitBid' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireAllowlisted(signer);
  if (auctionPhase(s, now) !== 'Open') throw new ChainError('WrongPhase', 'commit phase is over or not started');
  if (s.bids.has(signer)) throw new ChainError('Duplicate', 'one bid per wallet (A-AUC-2)');
  const deposit = big(cmd.deposit);
  if (deposit <= 0n) throw new ChainError('InvalidTerms', 'deposit must be positive');
  e.debit(signer, s.terms.stablecoinMint, deposit);
  const order = s.bidOrder++;
  s.bids.set(signer, { bidder: signer, commitment: cmd.commitment, deposit, order, revealed: null, allocatedUnits: 0n, refundable: 0n, refunded: 0n, settled: false });
  emit('BidCommitted', { seriesId: s.seriesId, bidder: signer, commitment: cmd.commitment, deposit: cmd.deposit, order });
}
export function revealBid(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'revealBid' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (auctionPhase(s, now) !== 'Reveal') throw new ChainError('WrongPhase', 'not in the reveal phase');
  const b = s.bids.get(signer);
  if (!b) throw new ChainError('NotFound', 'no bid to reveal');
  if (b.revealed) throw new ChainError('Duplicate', 'already revealed');
  const price = big(cmd.pricePerUnit);
  const qty = big(cmd.quantity);
  const expected = bidCommitment({ seriesId: s.seriesId, bidder: signer, pricePerUnit: price, quantity: qty, salt: cmd.salt });
  if (expected !== b.commitment) throw new ChainError('InvalidCommitment', 'reveal does not match the commitment');
  const needed = price * qty + bpsOf(price * qty, s.terms.auctionFeeBps);
  if (needed > b.deposit) throw new ChainError('InsufficientFunds', 'deposit does not cover price × quantity plus the fee');
  b.revealed = { pricePerUnit: price, quantity: qty };
  emit('BidRevealed', { seriesId: s.seriesId, bidder: signer, pricePerUnit: cmd.pricePerUnit, quantity: cmd.quantity });
}
export function settleAuction(e: EngineCore, cmd: Extract<Command, { kind: 'settleAuction' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (auctionPhase(s, now) !== 'SettleDue') throw new ChainError('TooEarly', 'reveal phase has not ended');
  const mint = s.terms.stablecoinMint;
  // a bidder removed from the allowlist between commit and settlement is excluded (its deposit is refundable), never a reason to brick settlement (C10)
  const revealed = [...s.bids.values()].filter((b) => b.revealed && e.state.allowlist.has(b.bidder)).map((b) => ({ bidder: b.bidder, pricePerUnit: b.revealed!.pricePerUnit, quantity: b.revealed!.quantity, order: b.order }));
  const res = interim.clearAuction({ bids: revealed, unitsOffered: s.terms.unitsOffered, reservePrice: s.terms.reservePrice, minimumRaise: s.terms.minimumRaise, walletCapUnits: interim.walletCapUnits(s.terms.unitsOffered, s.terms.walletCapBps), auctionFeeBps: s.terms.auctionFeeBps });
  if (!res.success) {
    for (const b of s.bids.values()) {
      b.refundable = b.deposit;
      b.settled = true;
    }
    s.phase = 'Failed';
    emit('AuctionFailed', { seriesId: s.seriesId, reason: res.reason! });
    return;
  }
  for (const b of s.bids.values()) {
    const alloc = res.allocations.find((a) => a.bidder === b.bidder);
    if (alloc) {
      b.allocatedUnits = alloc.units;
      b.refundable = b.deposit - alloc.amount - alloc.fee;
      e.credit(e.state.feeCollector, mint, alloc.fee);
      emit('FeeTaken', { seriesId: s.seriesId, kind: 'auction', amount: str(alloc.fee), payer: b.bidder });
      const p = position(s, b.bidder);
      setUnits(s, p, p.units + alloc.units);
      registerHolder(s, p); // Stage 1 registers every allocated bidder (SIM:1005)
      emit('UnitsMinted', { seriesId: s.seriesId, holder: b.bidder, units: str(alloc.units) });
    } else {
      b.refundable = b.deposit;
    }
    b.settled = true;
  }
  s.phase = 'Settled';
  s.settledAt = now;
  s.ledger.firstPeriod = pidAtTime(now); // SIM:972
  s.issuePrice = res.clearingPrice;
  s.unitsSold = res.unitsSold;
  s.unitsOutstanding = res.unitsSold;
  s.capPerUnit = capPerUnit(s.terms.capMultipleWad, res.clearingPrice); // Stage 1's floor(m × P0 / WAD)
  s.treasuryTotal = res.proceeds;
  let allocated = 0n;
  s.tranches = s.terms.releaseSchedule.map((t, i, arr) => {
    const amount = i === arr.length - 1 ? res.proceeds - allocated : bpsOf(res.proceeds, BigInt(t.bps));
    allocated += amount;
    return { index: i, afterSeconds: t.afterSeconds, bps: t.bps, amount, drawn: false, returned: false };
  });
  emit('AuctionSettled', { seriesId: s.seriesId, clearingPrice: str(res.clearingPrice), unitsSold: str(res.unitsSold), proceeds: str(res.proceeds), totalFees: str(res.totalFees), settledAt: now });
  emit('TreasuryFunded', { seriesId: s.seriesId, amount: str(res.proceeds) });
}
export function claimRefund(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimRefund' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const b = s.bids.get(signer);
  if (!b) throw new ChainError('NotFound', 'no bid');
  if (!b.settled) throw new ChainError('TooEarly', 'auction not settled');
  if (b.refundable === 0n) throw new ChainError('NotFound', 'nothing to refund');
  const amount = b.refundable;
  b.refundable = 0n;
  b.refunded += amount;
  e.credit(signer, s.terms.stablecoinMint, amount);
  emit('BidRefunded', { seriesId: s.seriesId, bidder: signer, amount: str(amount) });
}

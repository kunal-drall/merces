import { ChainError, auctionRulesOf, bidCommitment, type Command } from '@merces/domain';
import { U64_MAX, isBidValid } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { TERMINAL, big, u64, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';

// ------------------------------------------------------------------ the sealed-bid raise: open, cancel, commit, reveal
// (settlement: ./settlement.ts; the deprecated one-step composites: ./composite.ts)
/**
 * Stage 1 `open_raise` (SIM:871-883), in its order: the issuer (NotIssuer), a Draft raise (RaiseNotDraft), a contract
 * hash (ContractHashMissing; unreachable here, as `createSeries` refuses a zero hash, kept for parity), the issuer still
 * allowlisted (NotAllowlisted), new raises not paused (NewRaisesPaused); then our curve guard. The phase ends come from
 * the series' terms: commit end = now + `commitDurationSeconds`, reveal end = commit end + `revealDurationSeconds`.
 */
export function openRaise(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'openRaise' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Draft') fail('RaiseNotDraft', `series is ${s.phase}`);
  if (/^0x0{64}$/.test(s.terms.contractHash)) fail('ContractHashMissing', 'contract hash not set');
  if (!e.state.allowlist.has(s.issuer)) fail('NotAllowlisted', 'the issuer is not allowlisted');
  if (e.state.newRaisesPaused) fail('NewRaisesPaused', 'new raises are paused by the protocol admin');
  if (s.terms.raiseStyle !== 'sealed') throw new ChainError('WrongPhase', 'curve-mode series do not run a sealed-bid raise');
  const commitEndsAt = now + s.terms.commitDurationSeconds;
  const revealEndsAt = commitEndsAt + s.terms.revealDurationSeconds;
  s.phase = 'Open';
  s.openedAt = now;
  s.commitEndsAt = commitEndsAt;
  s.revealEndsAt = revealEndsAt;
  emit('RaiseOpened', { seriesId: s.seriesId, commitEndsAt, revealEndsAt });
}
/**
 * Stage 1 `cancel_raise` (SIM:578-585) for a sealed raise: the issuer (NotIssuer), an Open raise (RaiseNotOpen), no bid
 * yet (BidsExist). No time check: a raise with no bid can be cancelled after its reveal end. A curve series keeps our
 * rules (S5): cancellable while Draft or Open, not terminal, with no curve units minted.
 */
export function cancelRaise(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'cancelRaise' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.curve) {
    if (s.phase !== 'Open' && s.phase !== 'Draft') throw new ChainError('WrongPhase', `series is ${s.phase}`);
    if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', `series is ${s.status}`);
    // curve buyers already hold units backed by the treasury: cancelling would strand them (A-CURVE-3)
    if (s.unitsOutstanding > 0n) throw new ChainError('TooLate', 'curve units exist; the raise can no longer be cancelled');
  } else {
    if (s.phase !== 'Open') fail('RaiseNotOpen', `the raise is ${s.phase}`);
    if (s.bids.size > 0) fail('BidsExist', 'bids exist; the raise can no longer be cancelled');
  }
  s.phase = 'Cancelled';
  emit('RaiseCancelled', { seriesId: s.seriesId });
}
/**
 * For display: the stored raise state, with an Open raise split by time into its commit phase (`Open`), its reveal
 * phase (`Reveal`, commitEndsAt ≤ now < revealEndsAt) and `SettleDue` after the reveal end. Any other state (Settling
 * included) passes through.
 */
export function auctionPhase(s: SimSeries, now: number): 'Draft' | 'Open' | 'Reveal' | 'SettleDue' | 'Settling' | 'Settled' | 'Failed' | 'Cancelled' {
  if (s.phase !== 'Open') return s.phase;
  if (now < s.commitEndsAt!) return 'Open';
  if (now < s.revealEndsAt!) return 'Reveal';
  return 'SettleDue';
}
/**
 * Stage 1 `commit_bid` (SIM:885-899), in its order: an Open raise (RaiseNotOpen), an allowlisted bidder
 * (NotAllowlisted), the commit phase (CommitPhaseClosed), one bid per wallet (BidExists), the escrow as a u64
 * (AmountOutOfRange) and above 0 (ZeroEscrow); then the escrow is debited (InsufficientEscrow) into the auction escrow.
 */
export function commitBid(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'commitBid' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.phase !== 'Open') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  e.requireAllowlisted(signer);
  if (now >= s.commitEndsAt!) fail('CommitPhaseClosed', 'the commit phase is over');
  if (s.bids.has(signer)) fail('BidExists', 'one bid per wallet (A-AUC-2)');
  const deposit = u64(cmd.deposit);
  if (deposit === 0n) fail('ZeroEscrow', 'the deposit must be above 0');
  e.debit(signer, s.terms.stablecoinMint, deposit);
  s.auction.escrowTotal += deposit;
  const order = s.bidOrder++;
  s.bids.set(signer, { bidder: signer, commitment: cmd.commitment, deposit, order, revealed: null, revealIndex: -1, valid: false, talliedRound: 0, processed: false, allocation: 0n, pendingUnits: 0n, pendingRefund: 0n, delivered: false });
  emit('BidCommitted', { seriesId: s.seriesId, bidder: signer, commitment: cmd.commitment, deposit: cmd.deposit, order });
}
/**
 * Stage 1 `reveal_bid` (SIM:901-915), in its order: an Open raise (RaiseNotOpen), the reveal phase (RevealNotStarted,
 * RevealPhaseClosed), a bid (BidNotFound), not yet revealed (AlreadyRevealed), the commitment (CommitmentMismatch). The
 * reveal never fails on validity: Stage 1's `isBidValid` (reserve, quantity within the wallet cap, escrow covering
 * `requiredEscrow`) is fixed on the bid, and an invalid bid is refunded in full at processing. No allowlist check.
 */
export function revealBid(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'revealBid' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.phase !== 'Open') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (now < s.commitEndsAt!) fail('RevealNotStarted', 'the reveal phase has not started');
  if (now >= s.revealEndsAt!) fail('RevealPhaseClosed', 'the reveal phase is over');
  const b = s.bids.get(signer);
  if (!b) fail('BidNotFound', 'no bid to reveal');
  if (b.revealed) fail('AlreadyRevealed', 'the bid is already revealed');
  const price = big(cmd.pricePerUnit);
  const qty = big(cmd.quantity);
  // a price or quantity outside u64 matches no commitment (the commitment builder refuses one, AmountOutOfRange)
  const inRange = price <= U64_MAX && qty <= U64_MAX;
  if (!inRange || bidCommitment({ seriesId: s.seriesId, bidder: signer, pricePerUnit: price, quantity: qty, salt: cmd.salt }) !== b.commitment) fail('CommitmentMismatch', 'the reveal does not match the commitment');
  const a = s.auction;
  b.revealed = { pricePerUnit: price, quantity: qty };
  b.revealIndex = a.revealedCount++;
  b.valid = isBidValid(price, qty, b.deposit, auctionRulesOf(s.terms));
  if (b.valid) a.validCount += 1;
  emit('BidRevealed', { seriesId: s.seriesId, bidder: signer, pricePerUnit: cmd.pricePerUnit, quantity: cmd.quantity, valid: b.valid });
}

import type { FinalState, TailState, VaultState } from '@merces/math';
import type { SimulatorChain } from '../src/chain.ts';
import type { SimAuction, SimBid, SimLedger, SimPosition, SimSeries } from '../src/state.ts';
import { position, registerHolder } from '../src/engine/holders.ts';

/**
 * White-box seeders for the simulator's Stage 1 state (S1 plan §2 rule 5): a unit test sets the preconditions
 * another work package's commands would produce by writing the state directly, never by running those commands.
 * They bypass `execute`, so they emit no events and are not atomic; use them only to arrange a test.
 */

/** The live series record (the engine replaces `state` after a failed transaction, so never keep it). */
export function seriesOf(chain: SimulatorChain, seriesId: string): SimSeries {
  const s = chain.state.series.get(seriesId);
  if (!s) throw new Error(`kit: no series ${seriesId}`);
  return s;
}

/** Overwrite ledger fields (Stage 1 names; periods are pids, e.g. `toPid('2026Q1')`). */
export function seedLedger(chain: SimulatorChain, seriesId: string, patch: Partial<SimLedger>): SimLedger {
  const s = seriesOf(chain, seriesId);
  Object.assign(s.ledger, patch);
  return s.ledger;
}

/** Overwrite vault fields; `balance` sets the stablecoin the vault holds (`vaultBalance`). */
export function seedVault(chain: SimulatorChain, seriesId: string, patch: Partial<VaultState> & { balance?: bigint }): VaultState {
  const s = seriesOf(chain, seriesId);
  const { balance, ...vault } = patch;
  s.vault = { ...s.vault, ...vault };
  if (balance !== undefined) s.vaultBalance = balance;
  return s.vault;
}

/** Overwrite tail-state fields (after a redemption). */
export function seedTail(chain: SimulatorChain, seriesId: string, patch: Partial<TailState>): TailState {
  const s = seriesOf(chain, seriesId);
  s.tail = { ...s.tail, ...patch };
  return s.tail;
}

/** Overwrite final-pool fields (after an extinguishment). */
export function seedFinal(chain: SimulatorChain, seriesId: string, patch: Partial<FinalState>): FinalState {
  const s = seriesOf(chain, seriesId);
  s.final = { ...s.final, ...patch };
  return s.final;
}

/**
 * Record an approved hardship pause `[start, end)` (unix seconds) as `approve_pause` would: append it, add its length
 * to `pausedTotal` and clear a pending request. `pauseNonce` is left alone (it counts requests).
 */
export function seedPause(chain: SimulatorChain, seriesId: string, start: number | bigint, end: number | bigint): SimLedger {
  const l = seriesOf(chain, seriesId).ledger;
  const p = { start: BigInt(start), end: BigInt(end) };
  if (p.end <= p.start) throw new Error('kit: a pause must end after it starts');
  l.pauses.push(p);
  l.pausedTotal += p.end - p.start;
  l.pauseRequested = false;
  return l;
}

/** Overwrite a holder's fields (creating the position when needed); `register: true` runs Stage 1's registration first. */
export function seedHolder(chain: SimulatorChain, seriesId: string, wallet: string, patch: Partial<SimPosition> & { register?: boolean } = {}): SimPosition {
  const s = seriesOf(chain, seriesId);
  const { register, ...fields } = patch;
  const p = position(s, wallet);
  if (register) registerHolder(s, p);
  Object.assign(p, fields);
  return p;
}

/** Overwrite auction-record fields (Stage 1's `Auction`; `tally` and `proposal` are replaced whole when given). */
export function seedAuction(chain: SimulatorChain, seriesId: string, patch: Partial<SimAuction>): SimAuction {
  const s = seriesOf(chain, seriesId);
  Object.assign(s.auction, patch);
  return s.auction;
}

/**
 * Create or overwrite a bid (Stage 1's `Bid`). A new bid starts committed and unrevealed, in the next commit order;
 * nothing is debited and the auction's counts and escrow are left alone (patch them with `seedAuction`).
 */
export function seedBid(chain: SimulatorChain, seriesId: string, bidder: string, patch: Partial<SimBid> = {}): SimBid {
  const s = seriesOf(chain, seriesId);
  let b = s.bids.get(bidder);
  if (!b) {
    b = { bidder, commitment: '0x' + '00'.repeat(32), deposit: 0n, order: s.bidOrder++, revealed: null, revealIndex: -1, valid: false, talliedRound: 0, processed: false, allocation: 0n, pendingUnits: 0n, pendingRefund: 0n, delivered: false };
    s.bids.set(bidder, b);
  }
  Object.assign(b, patch);
  return b;
}

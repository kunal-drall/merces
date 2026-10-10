import { ChainError, type Command } from '@merces/domain';
import { PARAMETER_BOUNDS, finalDistribute, settleHolderDelta, vested } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { accrualUnits, burnUnits, heldUnits, settleHolder } from './holders.ts';
import { liveCapPerUnit, mintFinalized, setStatus } from './ledger.ts';
import { redeemBody, redeemableUnits } from './redemption.ts';
import { deliverPending } from './settlement.ts';
import { syncReleaseBlock, syncStatus } from './status.ts';

/**
 * Amendments, extinguishment and the final pool on Stage 1 (SPEC v1.1 §6.9; Stage 1 simulator SIM:853-865,
 * 1419-1475), through `@merces/math`: `vested` for what the treasury keeps, `finalDistribute` for the final pool and
 * `settleHolderDelta` for a holder's share of it.
 */

/** A co-signing attestor must be registered and active (Stage 1 `requireActiveAttestor`; no revocation grace here). */
function requireCoSigningAttestor(e: EngineCore, signers: string[], attestor: string, what: string): void {
  if (!signers.includes(attestor) || !e.state.attestors.get(attestor)) fail('InvalidAttestorSignature', `${what} needs an active attestor as co-signer`);
}

// ------------------------------------------------------------------ amendments
/**
 * Stage 1 `amend_terms` (SIM:853-865). Checks, in order:
 *
 *  1. the issuer signs (NotIssuer);
 *  2. the stored status is not terminal (AmendmentAfterTerminal); Paused and Late are allowed, and there is no raise check;
 *  3. the attestor is active and co-signs (InvalidAttestorSignature);
 *  4. the new cap multiple is not above the current one and within Stage 1's bounds [2, 3]·WAD (UnfavourableAmendment).
 *
 * Effects: the live terms commitment and cap multiple, `amendmentNonce += 1`. Nothing retires here: a cap lowered below
 * what was paid retires on the next receipt (Stage 1's `retire_if_capped` arrives in S5).
 */
export function amendTerms(e: EngineCore, signers: string[], cmd: Extract<Command, { kind: 'amendTerms' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (signers[0] !== s.issuer) fail('NotIssuer', 'only the issuer may amend the terms');
  if (TERMINAL.has(s.status)) fail('AmendmentAfterTerminal', `series is ${s.status}`);
  requireCoSigningAttestor(e, signers, cmd.attestor, 'an amendment');
  const newCap = big(cmd.capMultipleWad);
  const b = PARAMETER_BOUNDS.capMultipleWad;
  if (newCap > s.terms.capMultipleWad || newCap < b.min || newCap > b.max) fail('UnfavourableAmendment', 'the cap multiple may only decrease, within [2, 3]');
  const previous = s.terms.termsCommitment;
  s.terms.termsCommitment = cmd.termsCommitment;
  s.terms.capMultipleWad = newCap;
  s.ledger.amendmentNonce += 1n;
  if (s.issuePrice !== null) s.capPerUnit = liveCapPerUnit(s);
  s.amendments.push({ at: now, termsCommitment: cmd.termsCommitment, capMultipleWad: newCap, attestor: cmd.attestor });
  emit('TermsAmended', { seriesId: s.seriesId, termsCommitment: cmd.termsCommitment, previousCommitment: previous, capMultipleWad: cmd.capMultipleWad, attestor: cmd.attestor });
}

// ------------------------------------------------------------------ extinguishment
/**
 * Stage 1 `extinguish` (SIM:1419-1447). Checks, in order:
 *
 *  1. two distinct attestors (SameAttestor);
 *  2. each is active and co-signs (InvalidAttestorSignature);
 *  3. the raise settled (RaiseNotSettled): a Draft or Open sealed raise and an ungraduated curve cannot be extinguished
 *     (amendment M5; they end by cancellation or failure instead), nor can a Cancelled or Failed one;
 *  4. the mint is final (MintNotFinalized);
 *  5. the stored status is not Extinguished (TerminalStatus); Retired and Redeemed are allowed.
 *
 * Effects: the final units are fixed (`unitsAtRedemption` on a Redeemed series, else `unitsOutstanding`); only the
 * **unvested** proceeds leave the treasury (`proceeds − vested(now)`: vested but undrawn tranches stay drawable by the
 * issuer up to `vested(extinguishedAt)`); `syncStatus` (the sync point, before the mutations); the unvested tranches are
 * marked returned and their amount moves into the vault and onto the final pool (`finalDistribute`: no fee, its own
 * carry); the vault's net accumulator is not touched. Then Extinguished, `extinguishedAt`, the open due and any
 * true-up cleared, `extinguishNonce += 1`.
 *
 * Events: `PaymentReceived{source: 'extinguishment', gross = net = returned, fee 0}` (returned > 0),
 * `SeriesExtinguished{returnedToHolders}`, `StatusChanged`, then the release-block events if the block ended.
 */
export function extinguish(e: EngineCore, signers: string[], cmd: Extract<Command, { kind: 'extinguish' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const [a1, a2] = cmd.attestors as [string, string];
  if (a1 === a2) fail('SameAttestor', 'two distinct attestors are required');
  requireCoSigningAttestor(e, signers, a1, 'an extinguishment');
  requireCoSigningAttestor(e, signers, a2, 'an extinguishment');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  if (!mintFinalized(s)) fail('MintNotFinalized', 'the raise is still processing its bids');
  if (s.status === 'Extinguished') fail('TerminalStatus', 'already extinguished');
  const wasRedeemed = s.status === 'Redeemed';
  const finalUnits = wasRedeemed ? s.redemption!.unitsAtRedemption : s.unitsOutstanding;
  const t = BigInt(now);
  const settledAt = BigInt(s.settledAt!);
  const schedule = s.tranches.map((x) => ({ atOffsetSeconds: BigInt(x.afterSeconds), bps: x.bps }));
  const unreleased = s.treasuryTotal - vested(t, settledAt, schedule, s.treasuryTotal);
  syncStatus(e, s, now, emit);
  let returned = 0n;
  for (const x of s.tranches) {
    if (settledAt + BigInt(x.afterSeconds) <= t) continue;
    x.returned = true;
    returned += x.amount;
  }
  if (returned !== unreleased) throw new ChainError('ChainSpecific', 'treasury tranches disagree with the vested amount'); // never happens: same split as Stage 1's
  if (unreleased > 0n) {
    s.treasuryReturned += unreleased;
    s.vaultBalance += unreleased;
    emit('PaymentReceived', { seriesId: s.seriesId, periodId: null, gross: str(unreleased), fee: '0', net: str(unreleased), source: 'extinguishment', paidPerUnitWad: str(s.vault.paidPerUnitWad) });
  }
  s.final = finalDistribute(s.final, unreleased, finalUnits).state;
  const l = s.ledger;
  s.extinguishedAt = now;
  l.openDuePeriod = null;
  l.openDueAmount = 0n;
  l.trueupDue = 0n;
  l.trueupAttestedAt = 0n;
  l.extinguishNonce += 1n;
  emit('SeriesExtinguished', { seriesId: s.seriesId, attestors: [a1, a2], returnedToHolders: str(unreleased) });
  setStatus(s, 'Extinguished', emit);
  // nothing more is owed: a lateness block on releases ends with the obligation (events only)
  syncReleaseBlock(s, now, emit);
}

// ------------------------------------------------------------------ the final pool
/**
 * The units a holder's final-pool share is weighed on (Stage 1 `claim_final`, SIM:1458-1466): on a series that
 * redeemed, its redeemed units, counting the units its redemption body would still redeem; otherwise its accrual units.
 */
function finalWeight(s: SimSeries, p: SimPosition): bigint {
  return s.redemption ? p.redeemedUnits + redeemableUnits(p) : accrualUnits(s, p);
}

/** A holder's share of the final pool it could take now, without moving its cursor (the read side of `takeFinal`). */
export function claimableFinal(s: SimSeries, p: SimPosition): bigint {
  if (s.status !== 'Extinguished' || !p.registered || p.finalClaimed) return 0n;
  return settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, finalWeight(s, p));
}

/**
 * A settled holder's weight and share of the final pool of an extinguished series (Stage 1 `claim_final`,
 * SIM:1458-1468). On a series that redeemed (amendment M4), a holder that still has units not held for a window ask has
 * them redeemed first (`redeemBody`: its pending payout, the redemption price and the tail catch-up, paid at once) and
 * its share is weighed on its redeemed units; otherwise on its accrual units. The share is
 * `floor((finalAccWad − lastFinalAccWad) × weight / WAD)`, 0 after the first final claim; moves the final cursor and
 * marks the holder claimed. The caller has delivered a pending auction bid and settled the holder.
 */
function finalShare(e: EngineCore, s: SimSeries, p: SimPosition, emit: Emit): { weight: bigint; share: bigint } {
  let weight: bigint;
  if (s.redemption) {
    if (redeemableUnits(p) > 0n) redeemBody(e, s, p, emit);
    weight = p.redeemedUnits;
  } else {
    weight = accrualUnits(s, p);
  }
  const share = p.finalClaimed ? 0n : settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, weight);
  p.lastFinalAccWad = s.final.finalAccWad;
  p.finalClaimed = true;
  return { weight, share };
}

/**
 * A registered holder's share of the final pool of an extinguished series (Stage 1 `claim_final`'s share,
 * SIM:1449-1475; `finalShare`); nothing on any other series. A pending auction bid is delivered first
 * (`deliverPending`). The caller (`claimPayout`) settles the holder before and burns its units after; `claimFinal` is the
 * command with Stage 1's own order and event.
 */
export function takeFinal(e: EngineCore, s: SimSeries, p: SimPosition, emit: Emit): bigint {
  if (s.status !== 'Extinguished') return 0n;
  deliverPending(e, s, p.wallet, emit); // Stage 1's claim_final delivers a pending auction allocation first (SIM:1453)
  return finalShare(e, s, p, emit).share;
}

/**
 * Stage 1 `claim_final` (SIM:1449-1475). Checks and effects, in order:
 *
 *  1. the stored status is Extinguished (TerminalStatus);
 *  2. a pending auction bid is delivered (`deliverPending`: its refund and units);
 *  3. the signer is a registered holder (HolderNotRegistered), settled on the vault cursor;
 *  4. its weight and share (`finalShare`: on a series that redeemed, its remaining units are redeemed first and it is
 *     weighed on its redeemed units; otherwise on its accrual units); the share is paid once;
 *  5. it is paid `pending + share` from the vault and its balance burns (reason `extinguishment`; the units held for a
 *     window ask stay until the window returns them).
 *
 * Events: `BidDelivered` (a pending bid), the redemption body's when it runs, then `FinalClaimed{units: weight, amount:
 * pending + share}` (0 included, SPEC's zero-amount rule) and the `UnitsBurned` of the remaining balance (the EVM
 * order: the claim event before its burn).
 */
export function claimFinal(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimFinal' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Extinguished') fail('TerminalStatus', 'the series is not extinguished');
  deliverPending(e, s, signer, emit); // SIM:1453
  const p = s.positions.get(signer);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleHolder(e, s, p);
  const { weight, share } = finalShare(e, s, p, emit);
  const amount = p.pending + share;
  p.pending = 0n;
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
  s.vaultBalance -= amount;
  s.vaultDistributedNet += amount;
  p.claimedTotal += amount;
  e.credit(p.wallet, s.terms.stablecoinMint, amount);
  emit('FinalClaimed', { seriesId: s.seriesId, holder: p.wallet, units: str(weight), amount: str(amount) });
  burnUnits(s, p, heldUnits(s, p), 'extinguishment', emit);
}

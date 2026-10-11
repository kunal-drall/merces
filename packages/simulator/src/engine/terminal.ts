import { requireWindowDelivery } from './holders.ts';
import { ChainError, amendDigest, extinguishDigest, type Command } from '@merces/domain';
import { PARAMETER_BOUNDS, U64_MAX, finalDistribute, settleHolderDelta, vested } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { accrualUnits, burnUnits, heldUnits, settleHolder } from './holders.ts';
import { liveCapPerUnit, mintFinalized, setStatus } from './ledger.ts';
import { redeemBody, redeemableUnits } from './redemption.ts';
import { deliverPending } from './settlement.ts';
import { syncReleaseBlock, syncStatus } from './status.ts';
import { requireSigned, signingContextOf } from './keys.ts';

/**
 * Amendments, extinguishment and the final pool on Stage 1 (SPEC v1.1 §6.9; Stage 1 simulator SIM:853-865,
 * 1419-1475), through `@merces/math`: `vested` for what the treasury keeps, `finalDistribute` for the final pool and
 * `settleHolderDelta` for a holder's share of it.
 */

// ------------------------------------------------------------------ amendments
/**
 * Stage 1 `amend_terms` (SIM:853-865; MercesRegistry.sol:634-661; merces_registry lib.rs:752-832; S4 WP11, D8). Checks,
 * in the EVM's order (the plan's D8; MercesRegistry.sol:643-650):
 *
 *  1. the issuer sends it (NotIssuer);
 *  2. the stored status is not terminal (AmendmentAfterTerminal); Paused and Late are allowed, and there is no raise check;
 *  3. the new cap multiple is a u64 (AmountOutOfRange; the EVM's `toU64` before the signature is read: no AMEND message
 *     encodes a larger cap);
 *  4. the attestor's signature over `MERCES_AMEND_V1(domain, series key, the live amendment nonce, termsCommitment,
 *     capMultipleWad)` recovers to `cmd.attestor`, an active attestor key (no grace: an amendment needs an active key;
 *     else InvalidAttestorSignature);
 *  5. the new cap multiple is not above the current one and within Stage 1's bounds [2, 3]·WAD (UnfavourableAmendment).
 *
 * Stage 1's reference checks the attestor by name before the cap (SIM:857-860) and has no u64 step; Solana checks the
 * key's activity, then the cap, then the signature (lib.rs:762-785): the adapter notes (S4 WP13). The sender is the
 * issuer, never the attestor: the attestor signs on its own device.
 *
 * Effects: the live terms commitment and cap multiple, `amendmentNonce += 1` (every AMEND signature over the old nonce is
 * dead). Nothing retires here: a cap lowered below what was paid retires on the next receipt (Stage 1's
 * `retire_if_capped` arrives in S5). Emits `TermsAmended` with the nonce that was signed (the pre-increment value, as
 * both chains emit it).
 */
export function amendTerms(e: EngineCore, signer: string | null, cmd: Extract<Command, { kind: 'amendTerms' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (signer !== s.issuer) fail('NotIssuer', 'only the issuer may amend the terms');
  if (TERMINAL.has(s.status)) fail('AmendmentAfterTerminal', `series is ${s.status}`);
  const newCap = big(cmd.capMultipleWad);
  if (newCap > U64_MAX) fail('AmountOutOfRange', 'the cap multiple is out of the u64 range');
  const nonce = s.ledger.amendmentNonce;
  const m = amendDigest(signingContextOf(e.state, s.seriesId), { amendmentNonce: nonce, termsCommitment: cmd.termsCommitment, capMultipleWad: newCap });
  const attestor = requireSigned(e, 'attestor', m.digest, { signer: cmd.attestor, signature: cmd.signature }, now); // active only: no grace
  const b = PARAMETER_BOUNDS.capMultipleWad;
  if (newCap > s.terms.capMultipleWad || newCap < b.min || newCap > b.max) fail('UnfavourableAmendment', 'the cap multiple may only decrease, within [2, 3]');
  const previous = s.terms.termsCommitment;
  s.terms.termsCommitment = cmd.termsCommitment;
  s.terms.capMultipleWad = newCap;
  s.ledger.amendmentNonce = nonce + 1n;
  if (s.issuePrice !== null) s.capPerUnit = liveCapPerUnit(s);
  s.amendments.push({ at: now, termsCommitment: cmd.termsCommitment, capMultipleWad: newCap, attestor });
  emit('TermsAmended', { seriesId: s.seriesId, termsCommitment: cmd.termsCommitment, previousCommitment: previous, capMultipleWad: cmd.capMultipleWad, attestor, nonce: nonce.toString() });
}

// ------------------------------------------------------------------ extinguishment
/**
 * Stage 1 `extinguish` (SIM:1419-1447; exit.rs:202-306; MercesVault.sol:585-612; S4 WP12, D8). Permissionless: the
 * sender is never checked, the two signatures are. Checks, in order:
 *
 *  1. the two named keys are distinct (SameAttestor; Solana's `AttestorsNotDistinct` on the supplied addresses,
 *     exit.rs:215-218);
 *  2. each signature over `MERCES_EXTINGUISH_V1(domain, series key, the live extinguish nonce)` recovers to its named
 *     key, an active attestor key (no grace: an extinguishment needs active keys; else InvalidAttestorSignature), A then
 *     B. Solana checks both keys' activity, then both signatures (exit.rs:219-228); the EVM recovers both first and
 *     compares the recovered addresses (MercesVault.sol:592-596: two malformed signatures, or one key's two signatures
 *     named as two keys, are SameAttestor there): adapter notes, S4 WP13;
 *  3. the raise settled (RaiseNotSettled): a Draft or Open sealed raise cannot be extinguished (amendment M5; it ends by
 *     cancellation or failure instead), nor can a Cancelled or Failed one, nor a curve before `completeCurve` (Stage 1
 *     exit.rs:229-236; an unfilled curve has nothing in its treasury);
 *  4. the mint is final (MintNotFinalized);
 *  5. the stored status is not Extinguished (TerminalStatus); Retired and Redeemed are allowed.
 *
 * Effects: the final units are fixed (`unitsAtRedemption` on a Redeemed series, else `unitsOutstanding`); only the
 * **unvested** proceeds leave the treasury (`proceeds − vested(now)`: vested but undrawn tranches stay drawable by the
 * issuer up to `vested(extinguishedAt)`); `syncStatus` (the sync point, before the mutations); the unvested tranches are
 * marked returned and their amount moves into the vault and onto the final pool (`finalDistribute`: no fee, its own
 * carry); the vault's net accumulator is not touched. Then Extinguished, `extinguishedAt`, the open due and any
 * true-up cleared, `extinguishNonce += 1` (an EXTINGUISH signature is dead once used).
 *
 * Events: `PaymentReceived{source: 'extinguishment', gross = net = returned, fee 0}` (returned > 0),
 * `SeriesExtinguished{returnedToHolders}`, `StatusChanged`, then the release-block events if the block ended.
 */
export function extinguish(e: EngineCore, cmd: Extract<Command, { kind: 'extinguish' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (cmd.attestorA === cmd.attestorB) fail('SameAttestor', 'two distinct attestors are required');
  const m = extinguishDigest(signingContextOf(e.state, s.seriesId), { extinguishNonce: s.ledger.extinguishNonce });
  const a1 = requireSigned(e, 'attestor', m.digest, { signer: cmd.attestorA, signature: cmd.signatureA }, now); // active only: no grace
  const a2 = requireSigned(e, 'attestor', m.digest, { signer: cmd.attestorB, signature: cmd.signatureB }, now);
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
  l.trueupYear = null;
  l.extinguishNonce += 1n;
  emit('SeriesExtinguished', { seriesId: s.seriesId, attestors: [a1, a2], returnedToHolders: str(unreleased) });
  setStatus(s, 'Extinguished', emit);
  // nothing more is owed: a lateness block on releases ends with the obligation (events only)
  syncReleaseBlock(s, now, emit);
}

// ------------------------------------------------------------------ the final pool
/**
 * The units a holder's final-pool share is weighed on (Stage 1 `claim_final`, both chains: MercesVault.sol:654-658,
 * claims.rs:486-490): on a series that redeemed, its redeemed units, counting the units its redemption body would still
 * redeem and the units held for an uncleared window ask (`escrowed`: they come back later and are redeemed then, and
 * carry their final share now, like every unit that existed at redemption); otherwise its accrual units (the ask's
 * units included). The reference now matches both chains after the DIV-S1I-1 fix at bafe1fb (regression vector 26).
 */
function finalWeight(s: SimSeries, p: SimPosition): bigint {
  return s.redemption ? p.redeemedUnits + redeemableUnits(p) + p.escrowed : accrualUnits(s, p);
}

/**
 * A holder's share of the final pool it could take now, without moving its cursor (the share `claimFinal` pays on top of
 * the net payout). On a curve series that did not redeem it is 0: the share of the holder's stake is credited into its
 * pending payout by the settlement and counted in `claimableNet` (any claim pays it); on one that redeemed it is the
 * share of its tendered units since its final cursor.
 */
export function claimableFinal(s: SimSeries, p: SimPosition): bigint {
  if (s.status !== 'Extinguished' || !p.registered) return 0n;
  if (s.curve) return s.redemption ? settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, p.redeemedUnits) : 0n;
  if (p.finalClaimed) return 0n;
  return settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, finalWeight(s, p));
}

/**
 * Curve mode's weight and share (Stage 1 claims.rs:424-452; the caller settled the holder on its stake): on a series
 * that redeemed, the holder's tendered units and their share since its final cursor (which moves); otherwise its stake,
 * with a share of 0 here because the settlement already credited the stake's share into the pending payout. Nothing is
 * redeemed and nothing burns; a second claim pays nothing more (the cursors moved).
 */
function curveFinalShare(s: SimSeries, p: SimPosition): { weight: bigint; share: bigint } {
  if (!s.redemption) return { weight: p.stakedUnits, share: 0n };
  const weight = p.redeemedUnits;
  const share = settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, weight);
  p.lastFinalAccWad = s.final.finalAccWad;
  return { weight, share };
}

/**
 * A settled holder's weight and share of the final pool of an extinguished series (Stage 1 `claim_final`,
 * SIM:1458-1468, with both chains' weight). On a series that redeemed (amendment M4), a holder that still has units not
 * held for a window ask has them redeemed first (`redeemBody`: its pending payout, the redemption price and the tail
 * catch-up, paid at once) and its share is weighed on its redeemed units plus the units held for an uncleared ask
 * (MercesVault.sol:658 `weight = redeemedUnits + escrow`, claims.rs:486-490; reference fixed at bafe1fb); otherwise on its accrual
 * units (the ask's units included). The share is `floor((finalAccWad − lastFinalAccWad) × weight / WAD)`, 0 after the
 * first final claim (the ask's units, once the window returns them, are redeemed by a later claim at a share of 0: they
 * were paid theirs already); moves the final cursor and marks the holder claimed. The caller (`claimFinal`) has
 * delivered a pending auction bid and settled the holder.
 */
function finalShare(e: EngineCore, s: SimSeries, p: SimPosition, emit: Emit): { weight: bigint; share: bigint } {
  let weight: bigint;
  if (s.redemption) {
    if (redeemableUnits(p) > 0n) redeemBody(e, s, p, emit);
    weight = p.redeemedUnits + p.escrowed;
  } else {
    weight = accrualUnits(s, p);
  }
  const share = p.finalClaimed ? 0n : settleHolderDelta(s.final.finalAccWad, p.lastFinalAccWad, weight);
  p.lastFinalAccWad = s.final.finalAccWad;
  p.finalClaimed = true;
  return { weight, share };
}

/**
 * Stage 1 `claim_final` (SIM:1449-1475). Checks and effects, in order:
 *
 *  1. the stored status is Extinguished (TerminalStatus);
 *  2. a pending auction bid is delivered (`deliverPending`: its refund and units);
 *  3. the signer is a registered holder (HolderNotRegistered), settled on the vault cursor;
 *  4. its weight and share (`finalShare`: on a series that redeemed, its remaining units are redeemed first and it is
 *     weighed on its redeemed units plus the units held for an uncleared window ask, as both chains weigh it;
 *     otherwise on its accrual units); the share is paid once;
 *  5. it is paid `pending + share` from the vault and its balance burns (reason `extinguishment`; the units held for a
 *     window ask stay until the window returns them).
 *
 * A curve series (claims.rs:424-452) has no bids to deliver, settles the holder on its stake (`settle_curve_holder`,
 * which on a series that did not redeem credits the stake's final share into the pending payout), weighs the share on
 * the holder's tendered units on a series that redeemed, else on its stake with a share of 0 (`curveFinalShare`), and
 * burns nothing.
 *
 * Events: `BidDelivered` (a pending bid), the redemption body's when it runs, then `FinalClaimed{units: weight, amount:
 * pending + share}` (0 included, SPEC's zero-amount rule) and the `UnitsBurned` of the remaining balance (the EVM
 * order: the claim event before its burn).
 */
export function claimFinal(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'claimFinal' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.status !== 'Extinguished') fail('TerminalStatus', 'the series is not extinguished');
  requireWindowDelivery(s, signer);
  deliverPending(e, s, signer, emit); // SIM:1453
  const p = s.positions.get(signer);
  if (!p || !p.registered) fail('HolderNotRegistered', 'not a registered holder of this series');
  settleHolder(e, s, p);
  const { weight, share } = s.curve ? curveFinalShare(s, p) : finalShare(e, s, p, emit);
  const amount = p.pending + share;
  p.pending = 0n;
  if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
  s.vaultBalance -= amount;
  s.vaultDistributedNet += amount;
  p.claimedTotal += amount;
  e.credit(p.wallet, s.terms.stablecoinMint, amount);
  emit('FinalClaimed', { seriesId: s.seriesId, holder: p.wallet, units: str(weight), amount: str(amount) });
  if (!s.curve) burnUnits(s, p, heldUnits(s, p), 'extinguishment', emit);
}

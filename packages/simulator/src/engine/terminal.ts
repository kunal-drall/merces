import { ChainError, DEFAULTS, type Command } from '@merces/domain';
import { accrueNet, perUnitCap } from '@merces/math';
import type { SimPosition, SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { setStatus } from './status.ts';

// ------------------------------------------------------------------ amendments and extinguishment
export function amendTerms(e: EngineCore, signers: string[], cmd: Extract<Command, { kind: 'amendTerms' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const issuer = signers[0];
  if (!issuer) throw new ChainError('Unauthorized', 'no signer');
  e.requireIssuer(s, issuer);
  if (!signers.includes(cmd.attestor)) throw new ChainError('Unauthorized', 'attestor must co-sign the amendment');
  e.requireAttestor(cmd.attestor);
  if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series ended');
  const newCap = big(cmd.capMultipleWad);
  if (newCap > s.terms.capMultipleWad) throw new ChainError('InvalidTerms', 'the cap multiple may only decrease');
  if (newCap < DEFAULTS.capMultipleMinWad) throw new ChainError('InvalidTerms', 'cap multiple below the floor');
  const previous = s.terms.termsCommitment;
  s.terms.termsCommitment = cmd.termsCommitment;
  s.terms.capMultipleWad = newCap;
  if (s.issuePrice !== null) s.capPerUnit = perUnitCap(newCap, s.issuePrice);
  s.amendments.push({ at: now, termsCommitment: cmd.termsCommitment, capMultipleWad: newCap, attestor: cmd.attestor });
  emit('TermsAmended', { seriesId: s.seriesId, termsCommitment: cmd.termsCommitment, previousCommitment: previous, capMultipleWad: cmd.capMultipleWad, attestor: cmd.attestor });
}
export function extinguish(e: EngineCore, signers: string[], cmd: Extract<Command, { kind: 'extinguish' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const [a1, a2] = cmd.attestors;
  if (!a1 || !a2 || a1 === a2) throw new ChainError('InvalidTerms', 'two distinct attestors required');
  if (!signers.includes(a1) || !signers.includes(a2)) throw new ChainError('Unauthorized', 'both attestors must sign');
  e.requireAttestor(a1);
  e.requireAttestor(a2);
  if (s.status === 'Extinguished') throw new ChainError('Duplicate', 'already extinguished');
  let returned = 0n;
  const returnTreasury = (): void => {
    const unreleased = s.treasuryTotal - s.treasuryReleased;
    for (const t of s.tranches) t.drawn = true;
    s.treasuryReleased = s.treasuryTotal;
    if (unreleased > 0n) {
      // Returned to holders pro rata, no fee, outside the cap (A-C11-6).
      s.accNetWad = accrueNet(s.accNetWad, unreleased, s.unitsOutstanding);
      s.vaultBalance += unreleased;
      returned = unreleased;
      emit('PaymentReceived', { seriesId: s.seriesId, periodId: null, gross: str(unreleased), fee: '0', net: str(unreleased), source: 'extinguishment', paidPerUnitWad: str(s.paidPerUnitWad) });
    }
  };
  if (s.curve && !s.curve.graduated && s.unitsOutstanding > 0n) {
    // curve buyers already hold units and their USDC sits in the treasury: there is no raise to cancel, so the
    // whole treasury goes back to them through the payout accumulator (claimPayout), like a settled series
    returnTreasury();
  } else if (s.phase === 'Draft' || s.phase === 'Open') {
    // an open raise ends with the issuer: every deposit becomes refundable, no fees, nothing can settle later
    for (const b of s.bids.values()) {
      b.refundable = b.deposit;
      b.settled = true;
    }
    s.phase = s.bids.size ? 'Failed' : 'Cancelled';
    emit(s.bids.size ? 'AuctionFailed' : 'RaiseCancelled', s.bids.size ? { seriesId: s.seriesId, reason: 'no-bids' } : { seriesId: s.seriesId });
  }
  if (s.phase === 'Settled' && s.unitsOutstanding > 0n) returnTreasury();
  s.extinguishedAt = now;
  s.pause = null;
  emit('SeriesExtinguished', { seriesId: s.seriesId, attestors: [a1, a2], returnedToHolders: str(returned) });
  setStatus(s, 'Extinguished', emit);
}
/** A holder's share of the final pool of an extinguished series; moves the holder's final cursor. Nothing yet: the unreleased treasury goes through the payout accumulator. */
export function takeFinal(_e: EngineCore, _s: SimSeries, _p: SimPosition, _emit: Emit): bigint {
  return 0n;
}

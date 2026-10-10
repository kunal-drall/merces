import { ChainError, type Command } from '@merces/domain';
import { releasable } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { releasesBlockedByLateness, syncStatus } from './status.ts';

// ------------------------------------------------------------------ treasury
/** The release schedule in Stage 1's shape (`ReleaseTranche`: offset from settlement, bps). */
function schedule(s: SimSeries): { atOffsetSeconds: bigint; bps: number }[] {
  return s.tranches.map((t) => ({ atOffsetSeconds: BigInt(t.afterSeconds), bps: t.bps }));
}

/**
 * What the issuer could draw now (Stage 1 `releasable`): the tranches vested by `now` (by the extinguishment time once
 * extinguished: vested tranches stay drawable after it) less what was released. Ignores the pause gates.
 */
export function releasableNow(s: SimSeries, now: number): bigint {
  if (s.phase !== 'Settled' || s.settledAt === null) return 0n;
  return releasable(BigInt(now), BigInt(s.settledAt), schedule(s), s.treasuryTotal, s.treasuryReleased, BigInt(s.extinguishedAt ?? 0));
}

/**
 * `claim_release` (SIM:1030-1044): NotIssuer, RaiseNotSettled, ReleasesPaused (the issuer's own pause), SeriesLate
 * (derived Late, or late underneath a hardship pause), NothingVested. Draws every vested tranche not drawn yet
 * (`FundsReleased` per tranche), credits the issuer, then `syncStatus`. Releases continue after the series turns
 * terminal, up to what had vested at the extinguishment.
 */
export function drawRelease(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'drawRelease' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may draw releases');
  if (s.phase !== 'Settled') fail('RaiseNotSettled', 'the raise has not settled');
  if (s.releasesPausedByIssuer) fail('ReleasesPaused', 'the issuer has paused releases');
  if (releasesBlockedByLateness(s, now)) fail('SeriesLate', 'releases are blocked while the series is late');
  const amount = releasableNow(s, now);
  if (amount === 0n) fail('NothingVested', 'no tranche is drawable yet');
  const vestedBy = s.extinguishedAt ?? now;
  let drawn = 0n;
  for (const t of s.tranches) {
    if (t.drawn || t.returned || s.settledAt! + t.afterSeconds > vestedBy) continue;
    t.drawn = true;
    drawn += t.amount;
    emit('FundsReleased', { seriesId: s.seriesId, amount: str(t.amount), trancheIndex: t.index });
  }
  if (drawn !== amount) throw new ChainError('ChainSpecific', 'treasury tranches disagree with the vested amount');
  s.treasuryReleased += amount;
  e.credit(signer, s.terms.stablecoinMint, amount);
  syncStatus(e, s, now, emit);
}

/** `set_release_pause`: the issuer pauses or resumes its own releases (events only while lateness already blocks them). */
export function pauseReleases(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'pauseReleases' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may pause its releases');
  if (s.releasesPausedByIssuer === cmd.paused) return;
  s.releasesPausedByIssuer = cmd.paused;
  if (s.ledger.releasesBlockedLate) return;
  if (cmd.paused) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'IssuerRequest' });
  else emit('ReleasesResumed', { seriesId: s.seriesId });
}

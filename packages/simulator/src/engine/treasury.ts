import { ChainError, type Command } from '@merces/domain';
import { str, type EngineCore, type Emit } from './core.ts';

// ------------------------------------------------------------------ treasury
export function drawRelease(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'drawRelease' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
  if (s.status === 'Extinguished') throw new ChainError('WrongStatus', 'series extinguished');
  if (s.releasesPausedLate || s.releasesPausedByIssuer) throw new ChainError('Paused', 'releases are paused');
  let any = false;
  for (const t of s.tranches) {
    if (t.drawn || s.settledAt! + t.afterSeconds > now) continue;
    t.drawn = true;
    s.treasuryReleased += t.amount;
    e.credit(signer, s.terms.stablecoinMint, t.amount);
    emit('FundsReleased', { seriesId: s.seriesId, amount: str(t.amount), trancheIndex: t.index });
    any = true;
  }
  if (!any) throw new ChainError('TooEarly', 'no tranche is drawable yet');
}
export function pauseReleases(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'pauseReleases' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  e.requireIssuer(s, signer);
  if (s.releasesPausedByIssuer === cmd.paused) return;
  s.releasesPausedByIssuer = cmd.paused;
  if (cmd.paused) {
    if (!s.releasesPausedLate) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'IssuerRequest' });
  } else if (!s.releasesPausedLate) emit('ReleasesResumed', { seriesId: s.seriesId });
}

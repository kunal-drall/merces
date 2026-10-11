import type { Command, RouterState } from '@merces/domain';
import { closeRouterPeriod as close, fromPid, routeIncome as route, periodEnd, pidAt, toPid, yearOf, U64_MAX } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { str, u64, TERMINAL, type EngineCore, type Emit } from './core.ts';
import { fail } from './errors.ts';
import { mintFinalized } from './ledger.ts';
import { vaultReceive } from './payments.ts';
import { periodRecord, syncStatus } from './status.ts';

function enabled(s: SimSeries) { if (!s.router || !s.terms.tierFlags.tier1) fail('RouterNotEnabled'); return s.router; }
function remember(e: EngineCore,s: SimSeries): void {
  for (const cp of s.router!.checkpoints) s.routerCheckpoints.set(cp.period,cp.ytdAtEnd);
  if (e.state.config.family === 'solana') for (const p of s.routerCheckpoints.keys()) if (!s.router!.checkpoints.some((c)=>c.period === p)) s.routerCheckpoints.delete(p);
}
/** EVM stores every checkpoint; Solana/reference retain only their eight-entry ring. */
function preserveEvmCheckpoints(e: EngineCore,s: SimSeries,last: number): void {
  if (e.state.config.family !== 'evm' || !s.router!.nextCheckpointPeriod) return;
  for (let p=s.router!.nextCheckpointPeriod;p<=last;p++) s.routerCheckpoints.set(p,yearOf(p)===s.router!.ytdYear ? s.router!.ytdReceived : 0n);
}
export function routerYtd(s: SimSeries,period: number): bigint | null {
  if (s.ledger.firstPeriod !== null && period < s.ledger.firstPeriod) return 0n;
  return s.routerCheckpoints.get(period) ?? null;
}
/** EVM route pulls from the caller; Solana funds the receiving token account and then sweeps it. */
export function routeIncome(e: EngineCore,signer: string,cmd: Extract<Command,{kind:'routeIncome'}>,now: number,emit: Emit): void {
  const s = e.series(cmd.seriesId), r = enabled(s), amount = u64(cmd.amount);
  if (s.routerBalance + amount > U64_MAX) fail('AmountOutOfRange');
  e.debit(signer,s.terms.stablecoinMint,amount);
  s.routerBalance += amount;
  if (!mintFinalized(s) && s.phase !== 'Failed' && s.phase !== 'Cancelled') {
    r.heldBeforeFinalization = s.routerBalance;
    emit('RouterIncomeHeld',{seriesId:s.seriesId});
    return;
  }
  distribute(e,s,now,emit);
}
export function sweepRouter(e: EngineCore,cmd: Extract<Command,{kind:'sweepRouter'}>,now: number,emit: Emit): void {
  const s = e.series(cmd.seriesId); enabled(s);
  if (!mintFinalized(s) && s.phase !== 'Failed' && s.phase !== 'Cancelled') fail('MintNotFinalized');
  if (s.routerBalance === 0n) fail(e.state.config.family === 'solana' ? 'NothingToRoute' : 'ZeroAmount');
  distribute(e,s,now,emit);
}
function distribute(e: EngineCore,s: SimSeries,now: number,emit: Emit): void {
  const total = s.routerBalance;
  const rt = s.terms.routerTerms!;
  const units = s.phase !== 'Settled' || TERMINAL.has(s.status) ? 0n : s.unitsOutstanding;
  // A failed/cancelled raise and a terminal series pass everything through, as both programs do.
  const state = {...s.router!,theta:BigInt(rt.theta),rWad:BigInt(rt.rWad)};
  if (state.nextCheckpointPeriod === 0) state.nextCheckpointPeriod = pidAt(BigInt(now));
  preserveEvmCheckpoints(e,s,pidAt(BigInt(now))-1);
  const out = route(state,total,units,BigInt(now));
  if (out.state.ytdReceived > U64_MAX) fail('AmountOutOfRange');
  s.router = {...out.state,heldBeforeFinalization:0n};
  s.routerBalance = 0n;
  remember(e,s);
  e.credit(s.issuer,s.terms.stablecoinMint,out.passThrough);
  if (out.share > 0n) {
    const periodId = fromPid(pidAt(BigInt(now)));
    const {accepted} = vaultReceive(e,s,out.share,BigInt(now),{periodId,source:'split',payer:s.splitRouter!},now,emit);
    if (s.ledger.routerCredit + accepted > U64_MAX) fail('AmountOutOfRange');
    s.ledger.routerCredit += accepted;
    periodRecord(s,periodId).splitReceived += accepted;
    emit('SplitReceipt',{seriesId:s.seriesId,periodId,amount:str(accepted),router:s.splitRouter!});
  }
  emit('RouterIncomeRouted',{seriesId:s.seriesId});
  if (s.phase === 'Settled') syncStatus(e,s,now,emit);
}
export function closeRouterPeriod(e: EngineCore,cmd: Extract<Command,{kind:'closeRouterPeriod'}>,now: number,emit: Emit): void {
  const s = e.series(cmd.seriesId); enabled(s);
  if (e.state.config.family === 'evm' && s.phase !== 'Settled') fail('RaiseNotSettled');
  const period = toPid(cmd.periodId);
  if (BigInt(now) < periodEnd(period)) fail(e.state.config.family === 'solana' ? 'RouterPeriodNotEnded' : 'ReportTooEarly');
  if (e.state.config.family === 'solana' && period < s.router!.nextCheckpointPeriod) fail('RouterPeriodAlreadyClosed');
  if (!s.router!.nextCheckpointPeriod) s.router!.nextCheckpointPeriod = pidAt(BigInt(s.createdAt));
  preserveEvmCheckpoints(e,s,period);
  s.router = close(s.router!,period); remember(e,s);
  emit('RouterPeriodClosed',{seriesId:s.seriesId,periodId:cmd.periodId});
}
export function toRouterState(s: SimSeries): RouterState | null {
  if (!s.router) return null;
  return {seriesId:s.seriesId,receiver:s.splitRouter!,heldBeforeFinalization:str(s.routerBalance),ytdYear:s.router.ytdYear,ytdReceived:str(s.router.ytdReceived),
    nextCheckpointPeriod:s.router.nextCheckpointPeriod ? fromPid(s.router.nextCheckpointPeriod) : null,
    checkpoints:[...s.routerCheckpoints].map(([period,ytd])=>({periodId:fromPid(period),ytdAtEnd:str(ytd)}))};
}

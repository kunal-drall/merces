import {SeriesStatus,DEFAULT_PARAMETERS,isLateUnderlying,pidAt,statusParamsOf,type LedgerClock} from '@merces/math';
import {DEFAULTS} from './params.ts';
/** Public Stage 1 event fields only, with camel-case argument names on either chain. */
export interface ReleaseHistoryEvent {name:string;args:Record<string,unknown>;blockTime:number;}
export function releaseBlockFromHistory(events:readonly ReleaseHistoryEvent[],now:number):'IssuerRequest'|'Late'|null{
  const paused=events.filter((e)=>e.name==='ReleasePauseSet').at(-1);
  if(paused?.args.paused)return 'IssuerRequest';
  const settled=events.find((e)=>e.name==='RaiseSettled');if(!settled)return null;
  const clock:LedgerClock={status:SeriesStatus.OnTime,firstPeriod:pidAt(BigInt(String(settled.args.settlementTs))),lastAcceptedPeriod:null,openDuePeriod:null,openDueAmount:0n,pauses:[],trueupDue:0n,trueupAttestedAt:0n};
  for(const e of events){const a=e.args;
    if(e.name==='StatusChanged')clock.status=Number(a.newStatus??a.new);
    if(e.name==='TerminalStatusSet')clock.status=Number(a.status);
    if(e.name==='PauseApproved')clock.pauses=[...clock.pauses,{start:BigInt(String(a.start)),end:BigInt(String(a.end))}];
    if(e.name==='ReportAccepted'){clock.lastAcceptedPeriod=Number(a.period);clock.openDueAmount=BigInt(String(a.due));clock.openDuePeriod=clock.openDueAmount?Number(a.period):null;}
    if(e.name==='PaymentSettled'){clock.openDueAmount=0n;clock.openDuePeriod=null;}
    if(e.name==='TrueUpRecorded'){clock.trueupDue=BigInt(String(a.adjustment));if(clock.trueupDue<0n)clock.trueupDue=0n;clock.trueupAttestedAt=clock.trueupDue?BigInt(String(a.deadline))-BigInt(DEFAULT_PARAMETERS.trueupDays)*86400n:0n;}
    if(e.name==='TrueUpPaid'){clock.trueupDue=0n;clock.trueupAttestedAt=0n;}
  }
  return isLateUnderlying(clock,BigInt(now),statusParamsOf(DEFAULTS))?'Late':null;
}

import {describe,expect,it} from 'vitest';
import {releaseBlockFromHistory,type ReleaseHistoryEvent} from '../src/release-history.ts';
import {SeriesStatus,periodEnd,toPid} from '@merces/math';
const settled=Number(periodEnd(toPid('2025Q4')))+1,late=Number(periodEnd(toPid('2026Q1')))+46*86400;
const event=(name:string,args:Record<string,unknown>,blockTime=late):ReleaseHistoryEvent=>({name,args,blockTime});
const history=[event('RaiseSettled',{settlementTs:settled},settled)];
describe('historical release block',()=>{
 it('retains lateness underneath a hardship pause and respects issuer pause precedence',()=>{
  const h=[...history,event('StatusChanged',{old:0,new:SeriesStatus.Late}),event('PauseApproved',{start:late,end:late+86400}),event('StatusChanged',{old:SeriesStatus.Late,new:SeriesStatus.Paused})];
  expect(releaseBlockFromHistory(h,late)).toBe('Late');expect(releaseBlockFromHistory([...h,event('ReleasePauseSet',{paused:true})],late)).toBe('IssuerRequest');
  expect(releaseBlockFromHistory([...h,event('ReportAccepted',{period:toPid('2026Q1'),due:100}),event('PaymentSettled',{period:toPid('2026Q1')})],late)).toBeNull();
 });
 it('ends the late release block at a terminal transition',()=>{expect(releaseBlockFromHistory([...history,event('TerminalStatusSet',{status:SeriesStatus.Redeemed})],late)).toBeNull();});
});

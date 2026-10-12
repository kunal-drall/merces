import {describe,expect,it,vi} from 'vitest';
import type {ServiceContext} from '@merces/services';
import {KeeperScheduler} from '../src/scheduler.ts';
import type {KeeperJob} from '../src/jobs.ts';

function setup() {
 const status=vi.fn(async()=>({online:false}));
 const query=vi.fn(async()=>({rows:[]}));
 const ctx={localOperator:{status},pool:{query},chains:{chains:new Map()},log:{info:vi.fn(),error:vi.fn()}} as unknown as ServiceContext;
 const run=vi.fn(async()=>({actions:1}));
 const job:KeeperJob={name:'test.crank',requiresSigner:true,intervalSeconds:3600,run};
 return {status,query,ctx,run,job};
}
describe('hosted keeper signing availability',()=>{
 it('does not scan the chain or record a successful run while the signer is offline',async()=>{
  const {ctx,job,run,query}=setup();
  expect(await new KeeperScheduler(ctx,[job]).runAll()).toEqual({'test.crank':{ok:false,actions:0,detail:'deferred: local signing operator is offline'}});
  expect(run).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
 });
 it('resumes at the next tick without waiting for the long job interval',async()=>{
  vi.useFakeTimers();try{
   vi.setSystemTime(1_000_000_000);
   const {ctx,job,run,status}=setup();const stop=new AbortController();
   const pending=new KeeperScheduler(ctx,[job]).start(stop.signal,100);
   await vi.advanceTimersByTimeAsync(0);expect(run).not.toHaveBeenCalled();
   status.mockResolvedValue({online:true});
   await vi.advanceTimersByTimeAsync(100);expect(run).toHaveBeenCalledOnce();
   stop.abort();await vi.advanceTimersByTimeAsync(100);await pending;
  }finally{vi.useRealTimers();}
 });
 it('keeps reminder/outbox jobs running and preserves standalone signer behavior',async()=>{
  const {ctx,job,run}=setup();
  expect((await new KeeperScheduler(ctx,[]).runJob({...job,requiresSigner:false})).ok).toBe(true);
  delete ctx.localOperator;
  expect((await new KeeperScheduler(ctx,[]).runJob(job)).ok).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
 });
});

import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {dbTestsEnabled} from '@merces/db';
import {makeRig} from '../../api/test/helpers.ts';
import type {LocalOperator} from '../src/local-operator/service.ts';
describe.skipIf(!dbTestsEnabled())('local keeper manual reconciliation',()=>{
 let rig:Awaited<ReturnType<typeof makeRig>>;
 beforeAll(async()=>{rig=await makeRig();});afterAll(async()=>rig?.close());
 it('requires admin and replays the same receipt without signing again',async()=>{
  const submit=vi.fn(async()=>({txId:'test-receipt',blockTime:1,events:[]}));
  rig.ctx.localOperator={submit} as unknown as LocalOperator;
  const body={chain:'monad',seriesId:'monad:1'};
  expect((await rig.post('/admin/keepers/crank-status',body)).statusCode).toBe(401);
  const backer=rig.token({accountId:'backer',wallets:[],roles:['backer']});
  expect((await rig.post('/admin/keepers/crank-status',body,backer)).statusCode).toBe(403);
  const token=rig.token({accountId:'admin',wallets:[],roles:['admin']});
  for(let i=0;i<2;i++){
   const r=await rig.app.inject({method:'POST',url:'/admin/keepers/crank-status',payload:body,headers:{authorization:'Bearer '+token,'idempotency-key':'same-status-crank'}});
   expect(r.statusCode).toBe(200);expect(r.json().txId).toBe('test-receipt');
  }
  expect(submit).toHaveBeenCalledExactlyOnceWith('monad',{kind:'crankStatus',seriesId:'monad:1'},'keeper');
 });
});

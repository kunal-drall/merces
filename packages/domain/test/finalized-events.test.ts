import {describe,expect,it} from 'vitest';
import {FinalizedEvents,type DomainEvent} from '../src/index.ts';
type Raw={key:string;count:number};
const map=async(r:Raw)=>Array.from({length:r.count},(_,i)=>({cursor:`${r.key}:${i}`,seq:0,txId:r.key,type:'IssuerRegistered',chain:'test',payload:{issuer:'wallet'},blockTime:1,blockRef:'1',finality:'finalized'} as DomainEvent));
const make=()=>new FinalizedEvents<Raw>((r)=>`${r.key}:9`,map);
describe('finalized canonical stream',()=>{
 it('numbers expansions consecutively, skips internal logs, resumes mid-log and reproduces numbers on restart',async()=>{
  const history=[{key:'01',count:0},{key:'05',count:2},{key:'09',count:0},{key:'13',count:1}];
  const first=make();await first.update(history);
  expect(first.page(null,1).events.map((e)=>e.seq)).toEqual([1]);
  const cursor=first.page(null,1).nextCursor;
  expect(first.page(cursor,10).events.map((e)=>[e.cursor,e.seq])).toEqual([['05:1',2],['13:0',3]]);
  const restarted=make();await restarted.update(history);
  expect(restarted.page(cursor,10)).toEqual(first.page(cursor,10));
  await first.update([...history,{key:'20',count:1}]);
  expect(first.transaction('20')[0]?.seq).toBe(4);
 });
 it('serializes concurrent readers and retries a failed raw log without holes or duplicates',async()=>{
  let fail=true;const stream=new FinalizedEvents<Raw>((r)=>`${r.key}:9`,async(r)=>{if(r.key==='02'&&fail)throw new Error('unavailable');return map(r);});
  const h=[{key:'01',count:2},{key:'02',count:1}];
  await expect(stream.update(h)).rejects.toThrow('unavailable');fail=false;
  await Promise.all([stream.update(h),stream.update(h)]);
  expect(stream.page(null,10).events.map((e)=>e.seq)).toEqual([1,2,3]);
 });
});

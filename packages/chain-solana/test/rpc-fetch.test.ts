import {expect,it,vi} from 'vitest';
import {pacedFetch} from '../src/rpc-fetch.ts';
it('paces concurrent calls and a retry without delaying the first request',async()=>{
 vi.useFakeTimers();try{
  vi.setSystemTime(0);const started:number[]=[];
  const send=vi.fn(async()=>{started.push(Date.now());return new Response('{}');});
  const fetcher=pacedFetch(600,send);
  const requests=[fetcher('https://example.test'),fetcher('https://example.test'),fetcher('https://example.test')];
  expect(started).toEqual([0]);await vi.advanceTimersByTimeAsync(1200);await Promise.all(requests);
  const retry=fetcher('https://example.test');await vi.advanceTimersByTimeAsync(600);await retry;
  expect(started).toEqual([0,600,1200,1800]);
 }finally{vi.useRealTimers();}
});

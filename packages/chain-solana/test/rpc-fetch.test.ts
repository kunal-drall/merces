import {expect,it,vi} from 'vitest';
import {pacedFetch} from '../src/rpc-fetch.ts';
it('paces concurrent calls and a retry without delaying the first request',async()=>{
 vi.useFakeTimers();try{
  vi.setSystemTime(0);const started:number[]=[];
  const send=vi.fn(async()=>{started.push(Date.now());return new Response('{}');});
  const fetcher=pacedFetch(600,send);
  const requests=[fetcher('https://example.test'),fetcher('https://example.test'),fetcher('https://example.test')];
  await vi.advanceTimersByTimeAsync(0);expect(started).toEqual([0]);await vi.advanceTimersByTimeAsync(1200);await Promise.all(requests);
  const retry=fetcher('https://example.test');await vi.advanceTimersByTimeAsync(600);await retry;
  expect(started).toEqual([0,600,1200,1800]);
 }finally{vi.useRealTimers();}
});
it.each(['3', 'Thu, 01 Jan 1970 00:00:03 GMT'])('holds existing queued requests until Retry-After %s',async(header)=>{
 vi.useFakeTimers();try{
  vi.setSystemTime(0);const started:number[]=[];
  const send=vi.fn(async()=>{started.push(Date.now());return new Response('{}',started.length===1?{status:429,headers:{'retry-after':header}}:undefined);});
  const fetcher=pacedFetch(350,send);
  const requests=[fetcher('https://example.test'),fetcher('https://example.test'),fetcher('https://example.test')];
  await vi.advanceTimersByTimeAsync(2999);expect(started).toEqual([0]);
  await vi.advanceTimersByTimeAsync(351);await Promise.all(requests);expect(started).toEqual([0,3000,3350]);
 }finally{vi.useRealTimers();}
});
it('backs off repeated 429s with no usable header and never retries a request itself',async()=>{
 vi.useFakeTimers();try{
  vi.setSystemTime(0);const started:number[]=[];
  const send=vi.fn(async()=>{started.push(Date.now());return new Response('{}',{status:429,headers:{'retry-after':'invalid'}});});
  const fetcher=pacedFetch(350,send);
  const requests=Array.from({length:3},()=>fetcher('https://example.test'));
  await vi.advanceTimersByTimeAsync(3000);await Promise.all(requests);
  expect(started).toEqual([0,1000,3000]);expect(send).toHaveBeenCalledTimes(3);
 }finally{vi.useRealTimers();}
});
it('skips an aborted queued request and continues after a network failure',async()=>{
 vi.useFakeTimers();try{
  vi.setSystemTime(0);const controller=new AbortController();
  const send=vi.fn().mockRejectedValueOnce(new Error('network failed')).mockResolvedValue(new Response('{}'));
  const fetcher=pacedFetch(350,send);
  const failed=expect(fetcher('https://example.test')).rejects.toThrow('network failed');
  const cancelled=expect(fetcher('https://example.test',{signal:controller.signal})).rejects.toThrow();
  const next=fetcher('https://example.test');controller.abort();
  await vi.advanceTimersByTimeAsync(350);await Promise.all([failed,cancelled,next]);
  expect(send).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});

import{expect,it,vi}from'vitest';
import{pacedRpcFetch}from'../src/rpc-fetch.ts';
it('spaces concurrent RPC calls without changing payloads',async()=>{
 vi.useFakeTimers();try{const starts:number[]=[],send=vi.fn(async()=>{starts.push(Date.now());return new Response('{}');}),rpc=pacedRpcFetch(150,send);const body={method:'POST',body:'public rpc request'};const jobs=[rpc('https://example.invalid',body),rpc('https://example.invalid',body),rpc('https://example.invalid',body)];await vi.runAllTimersAsync();await Promise.all(jobs);expect(starts.map(n=>n-starts[0]!)).toEqual([0,150,300]);expect(send).toHaveBeenCalledWith('https://example.invalid',body);}finally{vi.useRealTimers();}
});
it('reserves the request budget for every element of an RPC batch',async()=>{
 vi.useFakeTimers();try{const starts:number[]=[],send=vi.fn(async()=>{starts.push(Date.now());return new Response('{}');}),rpc=pacedRpcFetch(150,send);const jobs=[rpc('https://example.invalid',{body:JSON.stringify([{id:1},{id:2},{id:3}])}),rpc('https://example.invalid',{body:'{}'}),rpc('https://example.invalid',{body:'[]'})];await vi.runAllTimersAsync();await Promise.all(jobs);expect(starts.map(n=>n-starts[0]!)).toEqual([0,450,600]);}finally{vi.useRealTimers();}
});

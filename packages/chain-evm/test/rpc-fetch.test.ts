import{expect,it,vi}from'vitest';
import{pacedRpcFetch}from'../src/rpc-fetch.ts';
it('spaces concurrent RPC calls without changing payloads',async()=>{
 vi.useFakeTimers();try{const starts:number[]=[],send=vi.fn(async()=>{starts.push(Date.now());return new Response('{}');}),rpc=pacedRpcFetch(150,send);const body={method:'POST',body:'public rpc request'};const jobs=[rpc('https://example.invalid',body),rpc('https://example.invalid',body),rpc('https://example.invalid',body)];await vi.runAllTimersAsync();await Promise.all(jobs);expect(starts.map(n=>n-starts[0]!)).toEqual([0,150,300]);expect(send).toHaveBeenCalledWith('https://example.invalid',body);}finally{vi.useRealTimers();}
});
it('reserves the request budget for every element of an RPC batch',async()=>{
 vi.useFakeTimers();try{const starts:number[]=[],send=vi.fn(async()=>{starts.push(Date.now());return new Response('{}');}),rpc=pacedRpcFetch(150,send);const jobs=[rpc('https://example.invalid',{body:JSON.stringify([{id:1},{id:2},{id:3}])}),rpc('https://example.invalid',{body:'{}'}),rpc('https://example.invalid',{body:'[]'})];await vi.runAllTimersAsync();await Promise.all(jobs);expect(starts.map(n=>n-starts[0]!)).toEqual([0,450,600]);}finally{vi.useRealTimers();}
});
it('serves a wallet read ahead of queued history while retaining the shared budget',async()=>{
 vi.useFakeTimers();try{
  const starts:{method:string;at:number}[]=[],rpc=pacedRpcFetch(150,async(_url,init)=>{starts.push({method:JSON.parse(String(init?.body)).method,at:Date.now()});return new Response('{}');});
  const run=(method:string)=>rpc('https://example.invalid',{body:JSON.stringify({method})});
  const jobs=[run('eth_getLogs'),run('eth_getLogs'),run('eth_getLogs'),run('eth_call')];
  await vi.runAllTimersAsync();await Promise.all(jobs);
  expect(starts.map(x=>x.method)).toEqual(['eth_getLogs','eth_call','eth_getLogs','eth_getLogs']);
  expect(starts.map(x=>x.at-starts[0]!.at)).toEqual([0,150,300,450]);
 }finally{vi.useRealTimers();}
});
it('does not starve historical indexing under sustained interactive traffic',async()=>{
 vi.useFakeTimers();try{
  const methods:string[]=[],rpc=pacedRpcFetch(150,async(_url,init)=>{methods.push(JSON.parse(String(init?.body)).method);return new Response('{}');});
  const run=(method:string)=>rpc('https://example.invalid',{body:JSON.stringify({method})});
  const jobs=[run('eth_call'),run('eth_getLogs'),...Array.from({length:7},()=>run('eth_call'))];
  await vi.runAllTimersAsync();await Promise.all(jobs);
  expect(methods.indexOf('eth_getLogs')).toBe(4);
 }finally{vi.useRealTimers();}
});

/** One public RPC budget, with interactive reads ahead of historical catch-up. */
export function pacedRpcFetch(intervalMs:number,send:typeof fetch=fetch):typeof fetch {
  type Job={input:Parameters<typeof fetch>[0];init:Parameters<typeof fetch>[1];weight:number;background:boolean;resolve:(response:Response)=>void;reject:(error:unknown)=>void};
  const queue:Job[]=[];
  let next=0,foregroundStarts=0,timer:ReturnType<typeof setTimeout>|undefined;
  const drain=()=>{
    timer=undefined;
    if(!queue.length)return;
    const wait=next-Date.now();
    if(wait>0){timer=setTimeout(drain,wait);return;}
    const foreground=queue.findIndex(job=>!job.background),background=queue.findIndex(job=>job.background);
    // Let history advance under sustained traffic, without letting log pages
    // reserve every future slot ahead of a wallet's dependent getters.
    const index=background>=0&&(foreground<0||foregroundStarts>=4)?background:foreground;
    const job=queue.splice(index,1)[0]!;
    if(job.init?.signal?.aborted){job.reject(job.init.signal.reason);drain();return;}
    foregroundStarts=job.background?0:foregroundStarts+1;
    next=Date.now()+intervalMs*job.weight;
    Promise.resolve().then(()=>send(job.input,job.init)).then(job.resolve,job.reject);
    if(queue.length)timer=setTimeout(drain,Math.max(0,next-Date.now()));
  };
  return (input,init)=>new Promise((resolve,reject)=>{
    let weight=1,background=false;
    if(typeof init?.body==='string')try{
      const parsed=JSON.parse(init.body),calls=Array.isArray(parsed)?parsed:[parsed];
      weight=Math.max(1,calls.length);
      background=calls.length>0&&calls.every(call=>call?.method==='eth_getLogs');
    }catch{/* Non-JSON requests retain the single-call budget. */}
    queue.push({input,init,weight,background,resolve,reject});
    if(timer===undefined)drain();
  });
}

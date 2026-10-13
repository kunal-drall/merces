/** Bound aggregate RPC request starts for the shared public testnet endpoint, including retries. */
export function pacedRpcFetch(intervalMs:number,send:typeof fetch=fetch):typeof fetch {
  let next=0;
  return async(input,init)=>{
    // Batch elements count against the endpoint's logical request limit too.
    let weight=1;
    if(typeof init?.body==='string')try{const body:unknown=JSON.parse(init.body);if(Array.isArray(body))weight=Math.max(1,body.length);}catch{/* Non-JSON requests retain the single-call budget. */}
    const now=Date.now(),at=Math.max(now,next);next=at+intervalMs*weight;
    if(at>now)await new Promise(resolve=>setTimeout(resolve,at-now));
    return send(input,init);
  };
}

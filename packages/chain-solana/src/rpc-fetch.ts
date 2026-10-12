/** Space starts across all RPC methods, including web3 retries, on Solana's shared public endpoint. */
export function pacedFetch(intervalMs:number, send:typeof fetch=fetch):typeof fetch {
  let next=0;
  return async(input,init)=>{
    const now=Date.now(),at=Math.max(now,next);next=at+intervalMs;
    if(at>now)await new Promise(resolve=>setTimeout(resolve,at-now));
    return send(input,init);
  };
}

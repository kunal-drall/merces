/** Share public readiness probes across callers. Never use for balances, authorization or transaction reads. */
export function readinessCache<T>(read:()=>Promise<T>,cacheable:(value:T)=>boolean,ttlMs=10_000,now=Date.now):()=>Promise<T>{
  let pending:Promise<T>|undefined;
  let recent:{value:T;until:number}|undefined;
  return ()=>{
    if(recent&&now()<recent.until)return Promise.resolve(recent.value);
    return pending??=read().then(value=>{
      recent=cacheable(value)?{value,until:now()+ttlMs}:undefined;
      return value;
    }).catch(error=>{recent=undefined;throw error;}).finally(()=>{pending=undefined;});
  };
}

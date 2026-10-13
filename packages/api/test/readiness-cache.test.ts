import {describe,expect,it,vi} from 'vitest';
import {readinessCache} from '../src/readiness-cache.ts';
import {buildApp} from '../src/app.ts';
import type {AppContext} from '../src/context.ts';

describe('public readiness probes',()=>{
  it('checks only the selected chain and shares its result with global probes',async()=>{
    const monad={chain:'monad',family:'evm',mode:'live',health:vi.fn(async()=>({ok:true,mode:'live',detail:'finalized'})),info:vi.fn(async()=>({chain:'monad',family:'evm',mode:'live',network:'testnet',stablecoins:{}}))};
    const solana={chain:'solana',family:'solana',mode:'live',health:vi.fn(async()=>({ok:false,mode:'live',detail:'offline'})),info:vi.fn(async()=>{throw new Error('offline');})};
    const ctx={chains:{chains:new Map([['monad',monad],['solana',solana]])},pool:{query:async()=>({rows:[]})},log:{error:vi.fn()},devMode:false} as unknown as AppContext;
    const app=await buildApp(ctx);
    try{
      expect((await app.inject('/health?chain=monad')).json()).toMatchObject({ok:true,chains:[{chain:'monad'}]});
      expect((await app.inject('/chains?chain=monad')).json().chains.map((c:{chain:string})=>c.chain)).toEqual(['monad']);
      expect(solana.health).not.toHaveBeenCalled();expect(solana.info).not.toHaveBeenCalled();
      expect((await app.inject('/health')).json().ok).toBe(false);
      expect(monad.health).toHaveBeenCalledOnce();expect(solana.health).toHaveBeenCalledOnce();
      expect((await app.inject('/health?chain=monad')).json().ok).toBe(true);
      expect((await app.inject('/health?chain=unknown')).statusCode).toBe(404);
      expect((await app.inject('/chains?chain=unknown')).statusCode).toBe(404);
    }finally{await app.close();}
  });
  it('shares concurrent work and expires the successful result from completion time',async()=>{
    let now=0,finish!:(value:{ok:boolean})=>void;
    const read=vi.fn(()=>new Promise<{ok:boolean}>(resolve=>{finish=resolve;}));
    const cached=readinessCache(read,value=>value.ok,10,()=>now);
    const first=cached(),second=cached();expect(read).toHaveBeenCalledOnce();
    now=20;finish({ok:true});expect(await first).toEqual(await second);
    now=29;await cached();expect(read).toHaveBeenCalledOnce();
    now=30;const expired=cached();expect(read).toHaveBeenCalledTimes(2);finish({ok:true});await expired;
  });
  it('does not preserve failed readiness or mask a failed refresh with an old success',async()=>{
    let now=0;
    const read=vi.fn<()=>Promise<{ok:boolean}>>().mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(new Error('RPC unavailable')).mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true});
    const cached=readinessCache(read,value=>value.ok,10,()=>now);
    await cached();now=10;await expect(cached()).rejects.toThrow('RPC unavailable');
    expect(await cached()).toEqual({ok:false});expect(await cached()).toEqual({ok:true});expect(read).toHaveBeenCalledTimes(4);
  });
  it('coalesces live health and catalogue routes without caching auction reads',async()=>{
    const chain={chain:'monad',family:'evm',health:vi.fn(async()=>({ok:true,mode:'live',detail:'finalized testnet'})),info:vi.fn(async()=>({chain:'monad',family:'evm',mode:'live',network:'testnet',stablecoins:{}})),getAuction:vi.fn(async()=>null),listBids:async()=>[],now:async()=>1};
    const ctx={chains:{chains:new Map([['monad',chain]])},chainFor:()=>chain,pool:{query:async()=>({rows:[]})},log:{error:vi.fn()},devMode:false} as unknown as AppContext;
    const app=await buildApp(ctx);
    try{
      const responses=await Promise.all(Array.from({length:3},()=>Promise.all([app.inject('/health'),app.inject('/chains')])));
      expect(responses.flat().map(r=>r.statusCode)).toEqual([200,200,200,200,200,200]);
      expect(chain.health).toHaveBeenCalledOnce();expect(chain.info).toHaveBeenCalledOnce();
      expect((await app.inject('/series/monad:1/auction')).statusCode).toBe(404);
      expect((await app.inject('/series/monad:1/auction')).statusCode).toBe(404);
      expect(chain.getAuction).toHaveBeenCalledTimes(2);
    }finally{await app.close();}
  });
  it('keeps mock catalogue changes immediately visible',async()=>{
    const info=vi.fn(async()=>({chain:'monad',family:'evm',mode:'mock',network:'local',stablecoins:{}}));
    const ctx={chains:{chains:new Map([['monad',{info}]])},log:{error:vi.fn()},devMode:false} as unknown as AppContext;
    const app=await buildApp(ctx);
    try{await app.inject('/chains');await app.inject('/chains');expect(info).toHaveBeenCalledTimes(2);}finally{await app.close();}
  });
});

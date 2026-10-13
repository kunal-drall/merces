import {expect,it,vi} from 'vitest';
import type {Session} from '@merces/api';
import type {ServiceContext} from '../src/context.ts';
import {ProofOfIncomeService} from '../src/poi/service.ts';
it('uses finalized pending metadata without history, but still enforces issuer ownership',async()=>{
 const pending={issuer:'issuer',status:'OnTime',now:1790000000,terms:{reportingCurrency:'USD',fxPairId:null,tierFlags:{tier1:false,tier2:true,tier3:false,tier4:false}}};
 const port={chain:'monad',getPendingReportingState:vi.fn(async()=>pending),getSeries:vi.fn(async()=>{throw Error('history unavailable');})};
 const pool={query:vi.fn()};const s=new ProofOfIncomeService({chainFor:()=>port,pool} as unknown as ServiceContext);
 const session={wallets:[{chain:'monad',address:'issuer'}],roles:['issuer']} as Session;
 expect(await s.schedule('monad:1',session)).toMatchObject({seriesId:'monad:1',now:1790000000,periods:[],upcoming:null,fxBasis:'unity'});
 expect(port.getSeries).not.toHaveBeenCalled();expect(pool.query).not.toHaveBeenCalled();
 await expect(s.schedule('monad:1',{...session,wallets:[{chain:'monad',address:'other'}]})).rejects.toThrow('not the issuer');
});
it('preserves the full reporting path once settlement has occurred',async()=>{
 const getSeries=vi.fn(async()=>{throw Error('history required');});
 const s=new ProofOfIncomeService({chainFor:()=>({chain:'monad',getPendingReportingState:async()=>null,getSeries})} as unknown as ServiceContext);
 await expect(s.schedule('monad:1',{wallets:[],roles:[]} as unknown as Session)).rejects.toThrow('history required');expect(getSeries).toHaveBeenCalledWith('monad:1');
});

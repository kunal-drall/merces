import {describe,expect,it,vi} from 'vitest';
import {advanceCurves} from '../../services/src/meteora/lifecycle.ts';
import {ChainError} from '@merces/domain';
import type {ServiceContext} from '../../services/src/context.ts';

function fixture(){
  const calls:string[]=[];
  const curve={poolComplete:true,migrated:false,settled:false,quoteReserve:'1000000',progressBps:10000,tradingFeeUncollected:'0',collected:{migrationFee:'0',surplus:'0'}};
  const chain={chain:'solana',family:'solana',mode:'live',now:async()=>1800000000,
    listSeries:async()=>[{seriesId:'solana:series',phase:'Open',terms:{raiseStyle:'curve'}}],
    getCurve:vi.fn(async()=>({...curve})),
    submit:vi.fn(async(command:{kind:string})=>{calls.push(command.kind);}),
    migrateCurve:vi.fn(async()=>{calls.push('migrateCurve');curve.migrated=true;curve.settled=true;}),
  };
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('max(chain_time)')?[{t:null,after_fill:false}]:[]}));
  const ctx={chains:{chains:new Map([['solana',chain]])},pool:{query}} as unknown as ServiceContext;
  return {calls,curve,chain,ctx,query};
}

describe('native curve graduation ordering',()=>{
  it('settles, confirms DAMM migration, then collects the treasury proceeds',async()=>{
    const {ctx,calls}=fixture();
    const result=await advanceCurves(ctx);
    expect(calls).toEqual(['completeCurve','migrateCurve','collectCurveProceeds']);
    expect(result.errors).toEqual([]);expect(result.collected).toEqual(['solana:series']);
  });
  it('does not collect or report success when migration fails',async()=>{
    const {ctx,chain,calls}=fixture();
    chain.migrateCurve.mockImplementation(async()=>{throw new ChainError('ChainSpecific','private RPC detail');});
    const result=await advanceCurves(ctx);
    expect(calls).toEqual(['completeCurve']);expect(result.collected).toEqual([]);
    expect(result.errors).toEqual([{target:'solana:series',error:'ChainSpecific'}]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not recreate an already migrated pool',async()=>{
    const {ctx,curve,chain}=fixture();curve.migrated=true;
    await advanceCurves(ctx);
    expect(chain.migrateCurve).not.toHaveBeenCalled();
  });
});

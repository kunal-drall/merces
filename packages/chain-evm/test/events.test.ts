import {describe,expect,it,vi} from 'vitest';
import {decodeEventLog,encodeAbiParameters,encodeEventTopics,type AbiEvent} from 'viem';
import {SeriesStatus} from '@merces/math';
import {EvmChain} from '../src/chain.ts';
import {abiOf,ZERO32} from '../src/abi.ts';
import {mapEvmEvent,eventCursor} from '../src/events.ts';
import {type EvmReadContext,type EvmRecord,EvmReads} from '../src/reads.ts';
const wallet='0x'+'12'.repeat(20),other='0x'+'34'.repeat(20);
/** Real pinned event ABI is the fixture wire format; decoding must retain its uint widths and indexed topics. */
function event(module:EvmRecord['module'],name:string,args:Record<string,unknown>,index=0):EvmRecord{
  const abi=abiOf(module),item=abi.find((a)=>a.type==='event'&&a.name===name) as AbiEvent;
  const topics=encodeEventTopics({abi,eventName:name,args});
  const params=item.inputs.filter((p)=>!p.indexed),data=encodeAbiParameters(params,params.map((p)=>args[p.name!]));
  const decoded=decodeEventLog({abi,data,topics:topics as never,strict:true});
  return {module,name,args:decoded.args as unknown as Record<string,unknown>,blockNumber:100n,logIndex:index,transactionIndex:0,txId:'0x'+'ab'.repeat(32),blockTime:1780000000};
}
const context=(history:EvmRecord[]=[]):EvmReadContext=>({chain:'monad',now:1780000000,stablecoins:{USDC:wallet},fxCurrencies:{},history:async()=>history,tokenBalance:async()=>0n,input:async()=>({name:'pay',args:[7n],sender:wallet}),read:async(_m,f)=>{if(f==='routerReceiver')return other;throw new Error('unexpected read '+f);}});
describe('Stage 1 EVM event accounting',()=>{
  it('splits redemption principal from pending payout and tail catch-up exactly once',async()=>{
    const opened=event('Vault','SeriesRedeemed',{series:7n,price:5n,hurdle:1n,dAvg:1n,capRemaining:12n,units:10n,deposit:50n});
    const claimed=event('Vault','RedemptionClaimed',{series:7n,holder:wallet,units:3n,amount:22n},1);
    const all=[opened,claimed],mapped=await mapEvmEvent(context(all),claimed,all);
    expect(mapped.map((e)=>[e.type,e.payload])).toEqual([
      ['PayoutClaimed',{seriesId:'monad:7',holder:wallet,amount:'7',burnedUnits:'0'}],
      ['RedemptionClaimed',{seriesId:'monad:7',holder:wallet,units:'3',amount:'15'}],
    ]);
    expect((await mapEvmEvent(context(),opened,[opened]))[0]?.payload).toMatchObject({tailCapPerUnit:'7',deposit:'50'});
    const reads=new EvmReads(context(all));
    expect(reads.redemption({redemptionTs:1780000000n,redemptionPrice:5n,unitsAtRedemption:10n,redemptionDeposit:50n,tailCapPerUnit:7n,tailPaidPerUnitWad:0n,tailAccWad:0n,tailExhausted:false,tailRefunded:0n},all)?.claimed).toBe('15');
  });
  it('maps accepted payment, fee and cap refund without double-counting PaymentSettled',async()=>{
    const distributed=event('Vault','PayoutDistributed',{series:7n,source:0,gross:120n,accepted:100n,fee:3n,netAdded:97n,deltaAccWad:1n,paidPerUnitWad:10n,retired:true});
    const settled=event('Income','PaymentSettled',{series:7n,period:8104,gross:120n,accrual:2n,fee:3n,accepted:100n,refunded:20n},1);
    const all=[distributed,settled],ctx=context(all);
    const mapped=await mapEvmEvent(ctx,distributed,all);
    expect(mapped.map((x)=>x.type)).toEqual(['PaymentRefunded','FeeTaken','PaymentReceived']);
    expect(mapped[2]?.payload).toMatchObject({gross:'100',net:'97',fee:'3',paymentDue:'118',accrual:'2',periodId:'2026Q1'});
    expect(await mapEvmEvent(ctx,settled,all)).toEqual([]);
  });
  it('maps raw routed income to value-free events and accepted share only',async()=>{
    const raw=event('Router','IncomeRouted',{series:7n,amount:987654321n,passThrough:987654221n,routed:100n,ytdReceived:987654321n});
    const mapped=await mapEvmEvent(context(),raw,[raw]);
    expect(mapped[0]?.payload).toEqual({seriesId:'monad:7'});
    expect(JSON.stringify(mapped)).not.toContain('987654321');
    const dist=event('Vault','PayoutDistributed',{series:7n,source:1,gross:100n,accepted:90n,fee:2n,netAdded:88n,deltaAccWad:1n,paidPerUnitWad:10n,retired:true});
    expect((await mapEvmEvent(context(),dist,[dist])).at(-1)?.payload).toMatchObject({router:other,amount:'90'});
  });
  it('maps burn reasons from SeriesStatus enum values and preserves zero settlement',async()=>{
    for(const [code,reason] of [[SeriesStatus.Retired,'cap'],[SeriesStatus.Redeemed,'redemption'],[SeriesStatus.Extinguished,'extinguishment']] as const){
      const e=event('Vault','UnitsBurned',{series:7n,holder:wallet,units:2n,reason:code});
      expect((await mapEvmEvent(context(),e,[e]))[0]?.payload).toMatchObject({reason});
    }
    const failed=event('Auction','RaiseFailed',{series:7n,clearingPrice:0n,proceeds:0n,minRaise:200n});
    expect((await mapEvmEvent(context(),failed,[failed]))[0]?.payload).toMatchObject({reason:'NoValidBids',minimumRaise:'200',unitsSold:'0'});
  });
  it('does not invent metadata absent from the Stage 1 FX event',async()=>{
    const e=event('FxAccumulator','FxSnapshot',{pair:ZERO32,day:20400,rateWad:100n,sumWad:200n,count:2});
    expect((await mapEvmEvent(context(),e,[e]))[0]?.payload).toMatchObject({confWad:null,publishTime:null});
  });
  it('resumes within expanded logs and advances past ignored logs',async()=>{
    const chain=new EvmChain({chain:'monad',network:'monad-testnet',chainId:10143,rpcUrl:'http://localhost:1',contracts:{MercesRegistry:wallet},abiDir:null,generatedDir:null,stablecoins:{},startBlock:0,finalityTag:'finalized',keeperAddress:null,allowlistManagerAddress:null});
    const e=event('Auction','NonRevealCharged',{series:7n,bidder:wallet,charge:2n});
    const ignored=event('Registry','MintFinalized',{series:7n},1),all=[e,ignored];
    vi.spyOn(chain.transport,'history').mockResolvedValue(all);
    vi.spyOn(chain.transport,'snapshotAt').mockResolvedValue(context(all));
    const first=await chain.readEvents(null,1),second=await chain.readEvents(first.nextCursor,1),third=await chain.readEvents(second.nextCursor,1);
    expect(first.events[0]?.type).toBe('NonRevealCharged');expect(second.events[0]?.type).toBe('FeeTaken');
    expect(third.events).toEqual([]);expect(third.nextCursor).toBe(eventCursor(ignored,31));
    expect(first.events[0]!.seq).toBeLessThan(second.events[0]!.seq);
  });
});

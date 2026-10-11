import {describe,expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {mapSolanaEvent} from '../src/events.ts';
import type {SolRecord} from '../src/transport.ts';
import type {SolanaReads} from '../src/reads.ts';
const key=(x:number)=>new PublicKey(Buffer.alloc(32,x)).toBase58(),series=key(1),holder=key(2);
const evt=(name:string,args:Record<string,unknown>,ordinal:number,invocation=1):SolRecord=>({module:'protocol',name,args:{series,...args},ordinal,invocation,slot:10,transactionIndex:0,logIndex:ordinal,txId:'tx',blockTime:1780000000});
const reads={config:{chain:'solana'},s:async()=>({mode:0})} as unknown as SolanaReads;
describe('Solana claim event accounting',()=>{
 it('splits principal from pending payouts and removes redemption already included in a final claim',async()=>{
  const redemption=evt('SeriesRedeemed',{price:10n,units:20n,deposit:200n,cap_remaining:12n},0),claim=evt('RedemptionClaimed',{holder,units:3n,amount:37n},1),final=evt('FinalClaimed',{holder,units:3n,amount:42n},2),all=[redemption,claim,final];
  const a=await mapSolanaEvent(reads,claim,all),b=await mapSolanaEvent(reads,final,all);
  expect(a.map((e)=>[e.type,(e.payload as {amount:string}).amount])).toEqual([['PayoutClaimed','7'],['RedemptionClaimed','30']]);
  expect(b[0]?.payload).toMatchObject({units:'3',amount:'5'});
 });
 it('keeps a final claim amount when an earlier redemption was a separate instruction',async()=>{
  const all=[evt('SeriesRedeemed',{price:10n,units:20n},0),evt('RedemptionClaimed',{holder,units:3n,amount:37n},1,1),evt('FinalClaimed',{holder,units:0n,amount:5n},2,2)];
  expect((await mapSolanaEvent(reads,all[2]!,all))[0]?.payload).toMatchObject({units:'3',amount:'5'});
 });
 it('preserves final-share weight of an uncleared ask after redemption',async()=>{
  const all=[evt('SeriesRedeemed',{price:10n,units:20n},0),evt('RedemptionClaimed',{holder,units:3n,amount:30n},1),evt('OrderCommitted',{owner:holder,period:8104,side:1,escrow:2n},2),evt('FinalClaimed',{holder,units:0n,amount:5n},3,2)];
  expect((await mapSolanaEvent(reads,all[3]!,all))[0]?.payload).toMatchObject({units:'5',amount:'5'});
 });
});

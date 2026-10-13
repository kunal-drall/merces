import {describe,expect,it} from 'vitest';
import type {AbiFunction,AbiParameter} from 'viem';
import {EvmReads,type EvmReadContext,type EvmRecord} from '../src/reads.ts';
import {abiOf,ZERO32,type EvmModule} from '../src/abi.ts';
const wallet='0x'+'11'.repeat(20),coin='0x'+'22'.repeat(20),sid='monad:1';
function zero(p:AbiParameter):unknown{
 if(p.type.endsWith('[]'))return [];if(p.type==='tuple')return Object.fromEntries((p as AbiParameter&{components:readonly AbiParameter[]}).components.map((c)=>[c.name,zero(c)]));
 if(p.type==='bool')return false;if(p.type==='address')return '0x'+'00'.repeat(20);if(p.type.startsWith('bytes'))return ZERO32;return 0n;
}
function fixture(){
 const rows=new Map<string,unknown>();
 for(const m of ['Registry','Income','Vault','Treasury','Auction','Window','Router','FxAccumulator'] as const)for(const fn of abiOf(m))if(fn.type==='function')rows.set(`${m}.${fn.name}`,fn.outputs.length===1?zero(fn.outputs[0]!):fn.outputs.map(zero));
 const patch=(key:string,value:Record<string,unknown>)=>rows.set(key,{...rows.get(key) as object,...value});
 rows.set('Registry.seriesCount',1n);patch('Registry.getSeriesCore',{issuer:wallet,stablecoin:coin,raiseState:4,settlementTs:1767225600n,tierFlags:2,unitToken:wallet,mintFinalized:true});
 patch('Registry.getSeriesTerms',{unitsOffered:10n,reservePrice:1000000n,minRaise:1000000n,hurdleRateWad:80000000000000000n,capMultipleWad:3000000000000000000n,lockupSeconds:0n,payoutMultipleK:1});
 rows.set('Registry.getReleaseSchedule',[{atOffsetSeconds:0n,bps:10000}]);patch('Registry.getIssuer',{registered:true,active:true});patch('Registry.attestorKey',{registered:true,active:true});patch('Registry.getFxPair',{exists:true});patch('Registry.getDefaults',{fxMinCoverageBps:8000});patch('Vault.getHolder',{registered:true});patch('Window.getWindow',{state:1,period:8104,commitEnd:1780000000n});rows.set('Window.currentWindow',[true,8104]);rows.set('FxAccumulator.quarterStats',[true,false,100n,75,false]);
 const events:EvmRecord[]=[];
 const ctx:EvmReadContext={chain:'monad',now:1767225601,stablecoins:{USDC:coin},fxCurrencies:{},read:async(m,f)=>{const k=`${m}.${f}`;if(!rows.has(k))throw new Error(`unknown getter ${k}`);return rows.get(k);},tokenBalance:async()=>0n,history:async()=>events,input:async()=>{throw new Error('no input');}};
 return {reads:new EvmReads(ctx),ctx,patch,rows,events};
}
describe('EVM read models against pinned ABI getter shapes',()=>{
 it('reads an unsettled reporting schedule without history and falls back after settlement',async()=>{
  const {reads,ctx,patch}=fixture();ctx.history=async()=>{throw new Error('history unavailable');};
  patch('Registry.getSeriesCore',{settlementTs:0n,raiseState:1});
  expect(await reads.getPendingReportingState(sid)).toMatchObject({issuer:wallet,now:1767225601,terms:{reportingCurrency:'USD',fxPairId:null,tierFlags:{tier2:true}}});
  expect(await reads.getPendingReportingState('monad:2')).toBeNull();
  patch('Registry.getSeriesCore',{settlementTs:1767225600n,raiseState:4});expect(await reads.getPendingReportingState(sid)).toBeNull();
  await expect(reads.getSeries(sid)).rejects.toThrow('history unavailable');
 });
 it('reads treasury releases and both pause causes without loading protocol history',async()=>{
  const {reads,ctx,patch,rows}=fixture();ctx.history=async()=>{throw new Error('history unavailable');};
  rows.set('Registry.getReleaseSchedule',[{atOffsetSeconds:0n,bps:5000},{atOffsetSeconds:86400n,bps:5000}]);
  rows.set('Treasury.trancheAmount',100n);patch('Treasury.getTreasury',{deposited:200n,releasedTotal:100n,movedToVault:20n});
  expect(await reads.getTreasury(sid)).toMatchObject({balance:'80',released:'100',paused:false,tranches:[{drawn:true,drawableAt:1767225600},{drawn:false,drawableAt:1767312000}]});
  patch('Treasury.getTreasury',{issuerPausedReleases:true});expect((await reads.getTreasury(sid))?.paused).toBe(true);
  patch('Treasury.getTreasury',{issuerPausedReleases:false});rows.set('Income.isLateUnderlying',true);expect((await reads.getTreasury(sid))?.paused).toBe(true);
  expect(await reads.getTreasury('monad:2')).toBeNull();
 });
 it('reads pending and revealed bids while event history is unavailable',async()=>{
  const {reads,ctx,patch}=fixture();ctx.history=async()=>{throw new Error('history unavailable');};
  patch('Auction.getAuction',{bidCount:1});patch('Auction.getBidAt',{bidder:wallet,escrow:1010000n});
  expect(await reads.getBid(sid,wallet)).toMatchObject({deposit:'1010000',processed:false,nonRevealCharge:'0'});
  patch('Auction.getBidAt',{processed:true,revealed:true,price:100000n,quantity:10n});
  expect(await reads.getBid(sid,wallet)).toMatchObject({processed:true,revealed:{pricePerUnit:'100000',quantity:'10'},nonRevealCharge:'0'});
  patch('Auction.getBidAt',{revealed:false});await expect(reads.getBid(sid,wallet)).rejects.toThrow('history unavailable');
 });
 it('preserves historical charges for processed unrevealed bids after delivery',async()=>{
  const {reads,patch,events}=fixture();patch('Auction.getAuction',{bidCount:1});patch('Auction.getBidAt',{bidder:wallet,escrow:1010000n,processed:true,delivered:true});
  events.push({module:'Auction',name:'NonRevealCharged',args:{series:1n,bidder:wallet,charge:50500n},blockNumber:1n,logIndex:0,transactionIndex:0,txId:ZERO32,blockTime:1767225600});
  expect(await reads.getBid(sid,wallet)).toMatchObject({processed:true,delivered:true,nonRevealCharge:'50500'});
 });
 it('reads an empty vault without waiting for holder history but requires it for positive balances',async()=>{
  const {reads,ctx,patch}=fixture();ctx.history=async()=>{throw new Error('history unavailable');};
  expect(await reads.getVault(sid)).toMatchObject({balance:'0',dust:'0'});
  patch('Vault.getLedger',{grossReceived:100n});await expect(reads.getVault(sid)).rejects.toThrow('history unavailable');
 });
 it('never calls unfunded zero-value tranches drawn and retains real releases',async()=>{
  const {reads,patch,rows}=fixture();patch('Registry.getSeriesCore',{settlementTs:0n,raiseState:1});
  expect((await reads.getTreasury(sid))?.tranches).toEqual([expect.objectContaining({amount:'0',drawableAt:null,drawn:false})]);
  patch('Registry.getSeriesCore',{settlementTs:1767225600n,raiseState:4});rows.set('Treasury.trancheAmount',100n);patch('Treasury.getTreasury',{deposited:100n,releasedTotal:0n});
  expect((await reads.getTreasury(sid))?.tranches[0]?.drawn).toBe(false);
  patch('Treasury.getTreasury',{releasedTotal:100n});expect((await reads.getTreasury(sid))?.tranches[0]?.drawn).toBe(true);
 });
 it('reads a settled series, bids, treasury, positions and a report without unprovided ABI fields',async()=>{
  const {reads}=fixture();expect(await reads.getIssuer(wallet)).toMatchObject({active:true});expect((await reads.listSeries())[0]).toMatchObject({phase:'Settled',unitScale:'1'});
  expect(await reads.getAuction(sid)).toMatchObject({bidCount:0});expect(await reads.listBids(sid)).toEqual([]);expect(await reads.getTreasury(sid)).toMatchObject({balance:'0'});
  expect(await reads.getPosition(sid,wallet)).toMatchObject({claimable:'0'});expect(await reads.getVault(sid)).toMatchObject({dust:'0'});expect(await reads.getPeriod(sid,'2026Q1')).toMatchObject({reportAccepted:false});
  expect(await reads.getSignerKey('attestor',wallet)).toMatchObject({active:true});expect(await reads.getTransferWindow(sid)).toMatchObject({periodId:'2026Q1'});
 });
 it('keeps computed FX averages separate from coverage and deviation eligibility',async()=>{
  const {reads,rows}=fixture();expect(await reads.getRateAccumulator(ZERO32)).toMatchObject({count:0,lastDayIndex:null});
  expect(await reads.getQuarterRate(ZERO32,'2026Q1')).toMatchObject({avgWad:'100',needsFallback:true});
  rows.set('FxAccumulator.quarterStats',[true,false,100n,90,true]);expect(await reads.getQuarterRate(ZERO32,'2026Q1')).toMatchObject({avgWad:'100',coverageOk:true,needsFallback:true,fallbackReason:'deviation'});
 });
 it('counts pending deliveries in redemption and tail previews',async()=>{
  const {reads,patch,rows}=fixture();patch('Vault.getLedger',{redemptionTs:1767225600n,redemptionPrice:10n,tailAccWad:3000000000000000000n});patch('Vault.getHolder',{lastTailAccWad:1000000000000000000n});rows.set('Auction.pendingUnitsOf',2n);rows.set('Window.pendingUnitsOf',3n);
  expect(await reads.getPosition(sid,wallet)).toMatchObject({undeliveredUnits:'5',redemptionClaimable:'55',tailClaimable:'10'});
 });
});

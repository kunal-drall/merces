import {describe,expect,it} from 'vitest';
import {decodeFunctionData} from 'viem';
import {defaultTerms,SimulatorChain} from '@merces/simulator';
import {ZERO_INCOME_COMMITMENT,reportPublicInputs,type Command} from '@merces/domain';
import {abiOf,calldata} from '../src/abi.ts';
import {planEvmCommand,type EvmCommandContext} from '../src/commands.ts';
const wallet='0x'+'12'.repeat(20),hash='0x'+'11'.repeat(32),sid='monad:7';
const base=(read:EvmCommandContext['read']):EvmCommandContext=>({chain:'monad',read,now:async()=>1_780_000_000,pythUpdateFee:async()=>27n});
const noRead=base(async()=>{throw new Error('unexpected chain read');});
const decode=async(cmd:Command,ctx=noRead)=>{const p=await planEvmCommand(ctx,cmd);return {plan:p,decoded:decodeFunctionData({abi:abiOf(p.module),data:calldata(p.module,p.functionName,p.args)})};};
describe('Stage 1 EVM calldata',()=>{
  it('encodes createSeries with pinned ABI tuples and an explicit later contract-hash step',async()=>{
    const t=defaultTerms(SimulatorChain.createSync({personality:'monad'})).terms;
    const {plan,decoded}=await decode({kind:'createSeries',terms:t},base(async(_m,f)=>{expect(f).toBe('getDefaults');return {auctionFeeBps:t.auctionFeeBps,payoutFeeBps:t.payoutFeeBps,windowFeeBps:t.windowFeeBps,nonRevealChargeBps:t.nonRevealChargeBps};}));
    expect(decoded.functionName).toBe('createSeries');
    expect(decoded.args?.[0]).toMatchObject({unitsOffered:BigInt(t.unitsOffered),minRaise:BigInt(t.minimumRaise),commitDuration:BigInt(t.commitDurationSeconds),windowRevealDuration:BigInt(t.windowRevealDuration)});
    expect(decoded.args?.[1]).toEqual(t.releaseSchedule.map((r)=>({atOffsetSeconds:BigInt(r.afterSeconds),bps:r.bps})));
    expect(plan.contractHashAfterCreate).toBe(t.contractHash);
    expect(decoded.args).not.toContain(t.contractHash);
  });
  it('tallies commit-index ranges including gaps left by unrevealed bids',async()=>{
    const ctx=base(async(_m,f,args)=>{
      if(f==='getAuction')return {bidCount:5,revealedCount:3,talliedCount:1,tallyRound:2};
      if(f==='getBidAt')return [{revealed:false,talliedRound:0},{revealed:true,talliedRound:2},{revealed:false,talliedRound:0},{revealed:true,talliedRound:1},{revealed:true,talliedRound:0}][Number(args![1])];
      throw new Error(f);
    });
    expect((await decode({kind:'tallyBids',seriesId:sid,maxBids:1},ctx)).decoded.args).toEqual([7n,3n,4n]);
  });
  it.each([false,true])('uses the correct report census (tail=%s) and Solidity pairing G2 ordering',async(tail)=>{
    const t=defaultTerms(SimulatorChain.createSync({personality:'monad'})).terms;
    const cmd:Extract<Command,{kind:'submitReport'}>={kind:'submitReport',seriesId:sid,periodId:'2026Q1',tier:1,paymentStable:'0',priorIncomeCommitment:ZERO_INCOME_COMMITMENT,incomeCommitment:ZERO_INCOME_COMMITMENT,fxAvgWad:'1000000000000000000',fxFallback:null,attestation:null,liquidityEvent:false,proof:{system:'groth16-bn254',proof:{pi_a:['1','2','1'],pi_b:[['3','4'],['5','6'],['1','0']],pi_c:['7','8','1'],protocol:'groth16',curve:'bn128'},publicInputs:[]}};
    cmd.proof.publicInputs=reportPublicInputs({...cmd,termsCommitment:t.termsCommitment,unitsOutstanding:'500'});
    const ctx=base(async(_m,f)=>f==='getSeriesCore'?{termsCommitment:t.termsCommitment,terminalStatus:tail?5:0}:f==='getLedger'?{unitsAtRedemption:500n}:tail?0n:500n);
    const {decoded}=await decode(cmd,ctx);
    expect(decoded.args?.[0]).toMatchObject({seriesId:7n,period:8104,proof:{a:[1n,2n],b:[[4n,3n],[6n,5n]],c:[7n,8n]}});
    await expect(decode({...cmd,proof:{...cmd.proof,publicInputs:Array(6).fill('0')}},ctx)).rejects.toThrow('proof public inputs differ');
  });
  it('checks historical window identity and emits a bounded ask-price prerequisite when a cancelled bid needs take-back',async()=>{
    const ctx=base(async(_m,f,args)=>{
      if(f==='currentWindow')return [true,8104];
      if(f==='priceIndexRequired')return true;
      if(f==='getWindow')return {orderCount:3,clearingPrice:5n,priceIndexLast:1n};
      if(f==='getOrderAt')return [{side:1,revealed:true,valid:true,price:3n},{side:1,revealed:true,valid:true,price:2n},{side:1,revealed:true,valid:true,price:3n}][Number(args![2])];
      throw new Error(f);
    });
    const {plan,decoded}=await decode({kind:'processOrder',seriesId:sid,windowId:8104,owner:wallet},ctx);
    expect(decoded.args).toEqual([7n,wallet]);
    const pre=plan.preparations![0]!;
    expect(decodeFunctionData({abi:abiOf(pre.module),data:calldata(pre.module,pre.functionName,pre.args)}).args).toEqual([7n,[2n,3n]]);
    await expect(decode({kind:'processOrder',seriesId:sid,windowId:8103,owner:wallet},ctx)).rejects.toThrow('window changed');
  });
  it('requires provider update bytes and forwards their native update fee',async()=>{
    const cmd:Extract<Command,{kind:'snapshotFx'}>={kind:'snapshotFx',pairId:hash,price:'100',conf:'1',expo:-2,publishTime:'1780000000',updates:['abcd']};
    const {plan,decoded}=await decode(cmd);
    expect(decoded.args).toEqual([hash,['0xabcd']]);expect(plan.value).toBe(27n);
    await expect(decode({...cmd,updates:[]})).rejects.toThrow('Pyth update');
  });
});

const addr=wallet;
const cases:Command[]=[
 {kind:'amendTerms',seriesId:sid,termsCommitment:hash,capMultipleWad:'2000000000000000000',attestor:addr,signature:'0x'+'11'.repeat(65)},
 {kind:'extinguish',seriesId:sid,attestorA:addr,signatureA:'0x'+'11'.repeat(65),attestorB:addr,signatureB:'0x'+'22'.repeat(65)},
 {kind:'rotateAttestor',from:addr,to:addr},{kind:'rotateVerifierKey',from:addr,to:addr},
 {kind:'setContractHash',seriesId:sid,contractHash:hash},{kind:'openRaise',seriesId:sid},{kind:'cancelRaise',seriesId:sid},
 {kind:'commitBid',seriesId:sid,commitment:hash,deposit:'9'},{kind:'revealBid',seriesId:sid,pricePerUnit:'3',quantity:'3',salt:hash},
 {kind:'beginSettlement',seriesId:sid,clearingPrice:'3',qAboveClaim:'0',qAtClaim:'3'},{kind:'tallyBids',seriesId:sid,maxBids:24},{kind:'finalizeSettlement',seriesId:sid},{kind:'processBid',seriesId:sid,bidder:wallet},{kind:'deliverBid',seriesId:sid,bidder:wallet},{kind:'registerHolder',seriesId:sid,wallet},
 {kind:'drawRelease',seriesId:sid},{kind:'pauseReleases',seriesId:sid,paused:true},{kind:'payIn',seriesId:sid,periodId:'2026Q1',amount:'9'},{kind:'payTrueUp',seriesId:sid},
 {kind:'submitTrueUp',seriesId:sid,year:2025,adjustment:'9',attestationTs:'1780000000',attestor:addr,signature:'0x'+'11'.repeat(65)},
 ...(['claimPayout','claimTail','claimFinal','claimRedemption','retireIfCapped','requestPause','withdrawPauseRequest','endPause','redeem','sweepRouter','crankStatus','crankPause'] as const).map((kind)=>({kind,seriesId:sid})),
 {kind:'burnRetired',seriesId:sid,holder:wallet},{kind:'approvePause',seriesId:sid,pauseEnd:'1780100000',attestor:addr,signature:'0x'+'11'.repeat(65)},
 {kind:'routeIncome',seriesId:sid,amount:'9'},{kind:'closeRouterPeriod',seriesId:sid,periodId:'2026Q1'},
 {kind:'openWindow',seriesId:sid,periodId:'2026Q1'},
 {kind:'commitWindowOrder',seriesId:sid,windowId:8104,side:'buy',commitment:hash,deposit:'9',units:'0'},
 {kind:'commitWindowOrder',seriesId:sid,windowId:8104,side:'sell',commitment:hash,units:'3',deposit:'0'},
 {kind:'revealWindowOrder',seriesId:sid,windowId:8104,side:'buy',pricePerUnit:'3',quantity:'3',salt:hash},
 {kind:'beginWindowSettlement',seriesId:sid,windowId:8104,clearingPrice:'3'},{kind:'tallyWindow',seriesId:sid,windowId:8104,maxOrders:24},{kind:'finalizeWindow',seriesId:sid,windowId:8104},{kind:'processOrder',seriesId:sid,windowId:8104,owner:wallet},{kind:'deliverOrder',seriesId:sid,windowId:8104,owner:wallet},
 {kind:'registerIssuer',wallet},{kind:'deactivateIssuer',wallet},{kind:'stopIssuance'},{kind:'resumeIssuance'},
 {kind:'registerAttestor',attestor:addr},{kind:'revokeAttestor',attestor:addr},{kind:'registerVerifierKey',key:addr},{kind:'revokeVerifierKey',key:addr},
 {kind:'setAllowlist',wallet,allowed:true},{kind:'setFeeCollector',feeCollector:wallet},{kind:'setFlags',windowsEnabled:true},{kind:'pauseNewRaises',paused:true},
 {kind:'setFxPair',feedId:hash,inverted:false,crosscheck:null},
];

const allContext=base(async(_m,f)=>{
 const values:Record<string,unknown>={getSeriesCore:{stablecoin:wallet},getSeriesTerms:{hurdleRateWad:0n},getLedger:{storedStatus:0,trueupDue:9n,trueupAttestedAt:1780000000n,redemptionTs:0n},getPauses:[],openDue:[9n,8104],lateAccrual:0n,previewRedemption:[0n,0n,0n,0n,9n],currentWindow:[true,8104],getWindow:{orderCount:1,tallyRound:1},getAuction:{bidCount:1,tallyRound:1},getBidAt:{revealed:true,talliedRound:0},getOrderAt:{revealed:true,talliedRound:0},priceIndexRequired:false,getFlags:{newRaisesPaused:false,windowsEnabled:false,tier4Enabled:false}};
 if(!(f in values))throw new Error(f);return values[f];
});
it.each(cases.map((c,i)=>[`${i} ${c.kind}`,c] as const))('%s encodes against the actual Stage 1 ABI',async(_name,command)=>{const {plan,decoded}=await decode(command,allContext);expect(decoded.functionName).toBe(plan.functionName);});

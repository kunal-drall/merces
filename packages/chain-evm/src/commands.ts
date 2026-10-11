import {ChainError,reportPublicInputs,type Command,type SeriesTerms} from '@merces/domain';
import {toPid,lateAccrualTrueup,DEFAULT_PARAMETERS,type SeriesStatus} from '@merces/math';
import type {Hex} from 'viem';
import {ZERO20,ZERO32,seriesNumber,type EvmModule} from './abi.ts';

export interface EvmCall {
  module:EvmModule;
  functionName:string;
  args:readonly unknown[];
  value?:bigint;
  /** Exact token spend that requires approval before this call. */
  approval?:{token:string;module:EvmModule;amount:bigint};
  /** EVM createSeries does not take a contract hash. Anchor it after the created id is known. */
  contractHashAfterCreate?:string;
  preparations?:EvmCall[];
}
export interface EvmCommandContext {
  chain:string;
  read(module:EvmModule,name:string,args?:readonly unknown[]):Promise<unknown>;
  now():Promise<number>;
  pythUpdateFee(updates:readonly Hex[]):Promise<bigint>;
}
type Row=Record<string,unknown>;
const row=(v:unknown)=>v as Row;
const big=(v:unknown)=>BigInt(v as string|bigint|number);
const tierBits=(t:SeriesTerms['tierFlags'])=>[t.tier1,t.tier2,t.tier3,t.tier4].reduce((n,on,i)=>n+(on?1<<i:0),0);
const routerTerms=(t:SeriesTerms['routerTerms'])=>({theta:BigInt(t?.theta??'0'),rWad:BigInt(t?.rWad??'0'),currencyCode:t?.currencyCode??0,indexingRule:t?.indexingRule??0,termsSalt:BigInt(t?.termsSalt??'0')});
/** Call plans use only pinned Stage 1 ABI fields. Product-only safeguards are checked before encoding. */
export async function planEvmCommand(ctx:EvmCommandContext,cmd:Command):Promise<EvmCall> {
  const id='seriesId' in cmd?seriesNumber(cmd.seriesId,ctx.chain):0n;
  const call=(module:EvmModule,functionName:string,args:readonly unknown[]=[]):EvmCall=>({module,functionName,args});
  if ('windowId' in cmd && cmd.kind!=='deliverOrder' && cmd.kind!=='clearTransferWindow') {
    const current=await ctx.read('Window','currentWindow',[id]) as [boolean,number];
    if(!current[0] || Number(current[1])!==cmd.windowId)throw new ChainError('WrongPhase','window changed; rebuild the transaction');
  }
  const core=async()=>row(await ctx.read('Registry','getSeriesCore',[id]));
  const spend=async(plan:EvmCall,amount:bigint)=>({...plan,approval:{token:String((await core()).stablecoin),module:plan.module,amount}});
  switch(cmd.kind) {
    case 'createSeries': {
      const t=cmd.terms;
      if(t.raiseStyle==='curve')throw new ChainError('NotPermitted','curve mode is Solana only',{stage1:'CurveModeUnsupported'});
      if(t.contractHash===ZERO32)throw new ChainError('InvalidTerms','a nonzero contract hash is required before the raise can open');
      if(cmd.seriesAddressHint)throw new ChainError('NotPermitted','fixed series ids are simulator-only');
      const defaults=row(await ctx.read('Registry','getDefaults'));
      for(const key of ['auctionFeeBps','payoutFeeBps','windowFeeBps','nonRevealChargeBps'] as const)if(Number(defaults[key])!==t[key])throw new ChainError('InvalidTerms','draft fees differ from the registry defaults; refresh the draft',{field:key});
      const p={stablecoin:t.stablecoinMint,unitsOffered:BigInt(t.unitsOffered),reservePrice:BigInt(t.reservePrice),minRaise:BigInt(t.minimumRaise),capMultipleWad:BigInt(t.capMultipleWad),hurdleRateWad:BigInt(t.hurdleWad),payoutMultipleK:BigInt(t.payoutMultipleK),lockupSeconds:BigInt(t.lockupSeconds),walletCapBps:BigInt(t.walletCapBps),commitDuration:BigInt(t.commitDurationSeconds),revealDuration:BigInt(t.revealDurationSeconds),windowCommitDuration:BigInt(t.windowCommitDuration),windowRevealDuration:BigInt(t.windowRevealDuration)};
      return {...call('Registry','createSeries',[p,t.releaseSchedule.map((r)=>({atOffsetSeconds:BigInt(r.afterSeconds),bps:r.bps})),t.termsCommitment,tierBits(t.tierFlags),t.fxPairId??ZERO32,0,false,routerTerms(t.routerTerms)]),contractHashAfterCreate:t.contractHash};
    }
    case 'openRaise':case 'cancelRaise':case 'finalizeSettlement':return call('Auction',cmd.kind,[id]);
    case 'commitBid':return spend(call('Auction','commitBid',[id,cmd.commitment,BigInt(cmd.deposit)]),BigInt(cmd.deposit));
    case 'revealBid':return call('Auction','revealBid',[id,BigInt(cmd.pricePerUnit),BigInt(cmd.quantity),cmd.salt]);
    case 'beginSettlement':return call('Auction','beginSettlement',[id,BigInt(cmd.clearingPrice),BigInt(cmd.qAboveClaim),BigInt(cmd.qAtClaim)]);
    case 'tallyBids': {
      const auction=row(await ctx.read('Auction','getAuction',[id]));
      const [from,to]=await tallyRange(ctx,'Auction','getBidAt',[id],Number(auction.bidCount),Number(auction.tallyRound),Math.min(cmd.maxBids??200,200));
      return call('Auction','tallyBids',[id,BigInt(from),BigInt(to)]);
    }
    case 'processBid':case 'deliverBid':return call('Auction',cmd.kind,[id,cmd.bidder]);
    case 'registerHolder':return call('Vault','registerHolder',[id,cmd.wallet]);
    case 'drawRelease':return call('Treasury','claimRelease',[id]);
    case 'pauseReleases':return call('Treasury','setReleasePause',[id,cmd.paused]);
    case 'submitReport': {
      if(cmd.proof.system!=='groth16-bn254')throw new ChainError('InvalidProof','mock proofs are refused on live chains');
      const c=await core();
      // MercesIncome._gateReport: after redemption the proof keeps the original redemption census.
      const units=Number(c.terminalStatus)===5?big(row(await ctx.read('Vault','getLedger',[id])).unitsAtRedemption):big(await ctx.read('Vault','unitsOutstanding',[id]));
      const signals=reportPublicInputs({termsCommitment:String(c.termsCommitment),unitsOutstanding:units.toString(),fxAvgWad:cmd.fxAvgWad,priorIncomeCommitment:cmd.priorIncomeCommitment,incomeCommitment:cmd.incomeCommitment,paymentStable:cmd.paymentStable});
      if(JSON.stringify(signals)!==JSON.stringify(cmd.proof.publicInputs))throw new ChainError('InvalidProof','proof public inputs differ from the live series');
      const p=cmd.proof.proof;
      // snarkjs G2 is [real,imaginary]; Solidity pairing precompiles take [imaginary,real].
      const proof={a:p.pi_a.slice(0,2).map(BigInt),b:p.pi_b.slice(0,2).map((v)=>[BigInt(v[1]!),BigInt(v[0]!)]),c:p.pi_c.slice(0,2).map(BigInt)};
      return call('Income','submitReport',[{seriesId:id,period:toPid(cmd.periodId),paymentUsd:BigInt(cmd.paymentStable),fxAvgWad:BigInt(cmd.fxAvgWad),fxFallbackSignature:cmd.fxFallback?.signature??'0x',priorIncomeCommitment:cmd.priorIncomeCommitment,incomeCommitment:cmd.incomeCommitment,tier:cmd.tier,liquidityEvent:cmd.liquidityEvent,proof,attestationSignature:cmd.attestation?.signature??'0x'}]);
    }
    case 'payIn': {
      const due=await ctx.read('Income','openDue',[id]) as readonly [bigint,number];
      if(cmd.periodId && toPid(cmd.periodId)!==Number(due[1]))throw new ChainError('WrongPhase','requested payment period is not the open due');
      const accrual=big(await ctx.read('Income','lateAccrual',[id,due[1],due[0],BigInt(await ctx.now())]));
      const total=due[0]+accrual;
      if(cmd.amount!==undefined && BigInt(cmd.amount)!==total)throw new ChainError('InvalidTerms','payment preview changed; refresh the amount');
      return spend(call('Income','pay',[id]),total);
    }
    case 'payTrueUp': {
      const l=row(await ctx.read('Income','getLedger',[id]));
      const ps=await ctx.read('Income','getPauses',[id]) as {start:bigint;end:bigint}[];
      const terms=row(await ctx.read('Registry','getSeriesTerms',[id]));
      const clock={status:Number(l.storedStatus) as SeriesStatus,firstPeriod:0,lastAcceptedPeriod:null,openDuePeriod:null,openDueAmount:0n,pauses:ps,trueupDue:big(l.trueupDue),trueupAttestedAt:big(l.trueupAttestedAt)};
      const accrual=lateAccrualTrueup(clock,BigInt(await ctx.now()),{...DEFAULT_PARAMETERS,hurdleRateWad:big(terms.hurdleRateWad)});
      return spend(call('Income','payTrueUp',[id]),big(l.trueupDue)+accrual);
    }
    case 'submitTrueUp':return call('Income','submitTrueUp',[id,cmd.year,BigInt(cmd.adjustment),BigInt(cmd.attestationTs),cmd.signature]);
    case 'claimPayout':return call('Vault','claim',[id]);
    case 'claimTail':case 'claimFinal':case 'claimRedemption':case 'retireIfCapped':return call('Vault',cmd.kind,[id]);
    case 'burnRetired':return call('Vault','burnRetired',[id,cmd.holder]);
    case 'requestPause':case 'withdrawPauseRequest':case 'endPause':return call('Income',cmd.kind,[id]);
    case 'approvePause':return call('Income','approvePause',[id,BigInt(cmd.pauseEnd),cmd.signature]);
    case 'amendTerms':return call('Registry','amendTerms',[id,cmd.termsCommitment,BigInt(cmd.capMultipleWad),cmd.signature,routerTerms(cmd.routerTerms)]);
    case 'extinguish':return call('Vault','extinguish',[id,cmd.signatureA,cmd.signatureB]);
    case 'redeem': {
      const ledger=row(await ctx.read('Vault','getLedger',[id]));
      // A quote guard cannot be enforced onchain: Stage 1 has no maxPrice argument. Reject a guarded live request.
      if(cmd.maxPricePerUnit!==undefined)throw new ChainError('NotPermitted','Stage 1 redeem has no onchain slippage parameter; rebuild without maxPricePerUnit');
      if(big(ledger.redemptionTs)>0n)throw new ChainError('WrongStatus','series already redeemed');
      const quote=await ctx.read('Vault','previewRedemption',[id,BigInt(await ctx.now())]) as readonly bigint[];
      return spend(call('Vault','redeem',[id]),quote[4]!);
    }
    case 'transferUnits':throw new ChainError('NotPermitted','direct unit transfers are forbidden',{stage1:'DirectTransferForbidden'});
    case 'routeIncome':return spend(call('Router','route',[id,BigInt(cmd.amount)]),BigInt(cmd.amount));
    case 'sweepRouter':return call('Router','sweep',[id]);
    case 'closeRouterPeriod':return call('Router','closeRouterPeriod',[id,toPid(cmd.periodId)]);
    case 'openWindow':return call('Window','openWindow',[id,toPid(cmd.periodId)]);
    case 'commitWindowOrder':return cmd.side==='buy'?spend(call('Window','commitBid',[id,cmd.commitment,BigInt(cmd.deposit)]),BigInt(cmd.deposit)):call('Window','commitAsk',[id,cmd.commitment,BigInt(cmd.units)]);
    case 'revealWindowOrder':return call('Window','revealOrder',[id,BigInt(cmd.pricePerUnit),BigInt(cmd.quantity),cmd.salt]);
    case 'beginWindowSettlement':return call('Window','beginWindowSettlement',[id,BigInt(cmd.clearingPrice??'0'),cmd.clearingPrice===null]);
    case 'finalizeWindow':return call('Window','finalizeWindow',[id]);
    case 'tallyWindow': {
      const w=row(await ctx.read('Window','getWindow',[id,cmd.windowId]));
      const [from,to]=await tallyRange(ctx,'Window','getOrderAt',[id,cmd.windowId],Number(w.orderCount),Number(w.tallyRound),Math.min(cmd.maxOrders,200));
      return call('Window','tallyOrders',[id,BigInt(from),BigInt(to)]);
    }
    case 'processOrder': {
      const plan=call('Window','processOrder',[id,cmd.owner]);
      if(!await ctx.read('Window','priceIndexRequired',[id]))return plan;
      const w=row(await ctx.read('Window','getWindow',[id,cmd.windowId]));
      const orders:Row[]=[];
      for(let i=0;i<Number(w.orderCount);i+=100)orders.push(...(await Promise.all(Array.from({length:Math.min(100,Number(w.orderCount)-i)},(_,j)=>ctx.read('Window','getOrderAt',[id,cmd.windowId,BigInt(i+j)])))).map(row));
      const prices=[...new Set(orders.filter((o)=>Number(o.side)===1 && o.revealed && o.valid && big(o.price)<big(w.clearingPrice) && big(o.price)>big(w.priceIndexLast)).map((o)=>big(o.price)))].sort((a,b)=>a<b?-1:a>b?1:0);
      const preparations:EvmCall[]=[];
      for(let i=0;i<prices.length;i+=200)preparations.push(call('Window','indexAskPrices',[id,prices.slice(i,i+200)]));
      return {...plan,preparations};
    }
    case 'deliverOrder':return call('Window','deliverOrder',[id,cmd.windowId,cmd.owner]);
    case 'setContractHash':return call('Registry','setContractHash',[id,cmd.contractHash]);
    case 'deactivateIssuer':return call('Registry','deactivateIssuer',[cmd.wallet]);
    case 'registerIssuer':return call('Registry','registerIssuer',[cmd.wallet]);
    case 'stopIssuance':case 'resumeIssuance':return call('Registry',cmd.kind);
    case 'registerAttestor':case 'revokeAttestor':return call('Registry',cmd.kind,[cmd.attestor]);
    case 'registerVerifierKey':case 'revokeVerifierKey':return call('Registry',cmd.kind,[cmd.key]);
    case 'rotateAttestor':case 'rotateVerifierKey':return call('Registry',cmd.kind,[cmd.from,cmd.to]);
    case 'setFeeCollector':return call('Registry','setFeeCollector',[cmd.feeCollector]);
    case 'setAllowlist':return call('Registry','setAllowed',[cmd.wallet,cmd.allowed]);
    case 'setFxPair':return call('Registry','setFxPair',[cmd.feedId,cmd.inverted,cmd.crosscheck??ZERO20]);
    case 'setFlags':case 'pauseNewRaises': {
      const f=row(await ctx.read('Registry','getFlags'));
      return call('Registry','setFlags',[cmd.kind==='pauseNewRaises'?cmd.paused:cmd.newRaisesPaused??f.newRaisesPaused,cmd.kind==='setFlags'?cmd.windowsEnabled??f.windowsEnabled:f.windowsEnabled,cmd.kind==='setFlags'?cmd.tier4Enabled??f.tier4Enabled:f.tier4Enabled]);
    }
    case 'snapshotFx': {
      if(!cmd.updates?.length || cmd.updates.some((u)=>! /^(?:0x)?[0-9a-fA-F]+$/.test(u)))throw new ChainError('InvalidTerms','verified Pyth update payloads are required');
      const updates=cmd.updates.map((u)=>(u.startsWith('0x')?u:`0x${u}`) as Hex);
      return {...call('FxAccumulator','snapshot',[cmd.pairId,updates]),value:await ctx.pythUpdateFee(updates)};
    }
    case 'crankStatus':case 'crankPause':return call('Income','crankStatus',[id]);
    case 'curveSwap':case 'stakeUnits':case 'unstakeUnits':case 'tenderUnits':case 'completeCurve':case 'collectCurveProceeds':case 'syncCurveUnits':throw new ChainError('NotPermitted','curve mode is Solana only',{stage1:'CurveModeUnsupported'});
    case 'snapshotRate':case 'openTransferWindow':case 'clearTransferWindow':case 'registerSplitRouter':case 'postSplitReceipt':case 'flagFxFallback':throw new ChainError('NotPermitted',`${cmd.kind} is a simulator convenience; use the Stage 1 canonical command`);
  }
}

/** EVM range indices are commit order, not the count of revealed bids/orders already tallied. */
async function tallyRange(ctx:EvmCommandContext,module:'Auction'|'Window',method:string,args:unknown[],count:number,round:number,max:number):Promise<[number,number]> {
  for(let base=0;base<count;base+=100) {
    const entries=await Promise.all(Array.from({length:Math.min(100,count-base)},(_,i)=>ctx.read(module,method,[...args,BigInt(base+i)])));
    const offset=entries.findIndex((r)=>row(r).revealed && Number(row(r).talliedRound)!==round);
    if(offset>=0)return [base+offset,Math.min(count,base+offset+max)];
  }
  throw new ChainError('WrongPhase','all revealed entries are already tallied');
}

import {ChainError,releaseBlockFromHistory,DEFAULTS,parseDomainEvent,makeSeriesId,type DomainEvent,type EventType} from '@merces/domain';
import {SeriesStatus,fromPid,pidAt} from '@merces/math';
import {ZERO20,ZERO32} from './abi.ts';
import {EvmReads,b,n,str,addr,record,type EvmReadContext,type EvmRecord} from './reads.ts';

/** A log may expand into several accounting events. The sub-index makes pagination lossless. */
export function eventCursor(e:EvmRecord,part:number):string{return `${e.blockNumber.toString().padStart(20,'0')}:${e.logIndex.toString().padStart(8,'0')}:${part.toString().padStart(3,'0')}`;}
export function canonicalEvent(chain:string,e:EvmRecord,part:number,type:EventType,payload:unknown):DomainEvent{
  const seq=Number(e.blockNumber)*1_000_000+e.logIndex*32+part;
  if(!Number.isSafeInteger(seq) || e.logIndex>=31250 || part>=32)throw new ChainError('ChainSpecific','event sequence exceeds its supported range');
  return parseDomainEvent({chain,cursor:eventCursor(e,part),seq,blockTime:e.blockTime,blockRef:e.blockNumber.toString(),txId:e.txId,finality:'finalized',type,payload});
}
/** Enrichment reads are pinned to the log's finalized block; mutable terms are reconstructed from prior events. */
export async function mapEvmEvent(ctx:EvmReadContext,e:EvmRecord,all:EvmRecord[]):Promise<DomainEvent[]> {
  const a=e.args,id=a.series===undefined?null:b(a.series),sid=id===null?'':makeSeriesId(ctx.chain,id.toString()),out:DomainEvent[]=[];
  const emit=(type:EventType,payload:unknown)=>out.push(canonicalEvent(ctx.chain,e,out.length,type,payload));
  const scope={seriesId:sid},s=(key:string)=>str(a[key]),num=(key:string)=>n(a[key]),address=(key:string)=>addr(a[key]);
  const prior=all.filter((x)=>x.blockNumber<e.blockNumber || x.blockNumber===e.blockNumber && x.logIndex<e.logIndex);
  const hist=prior.filter((x)=>id!==null && x.args.series!==undefined && b(x.args.series)===id);
  const same=all.filter((x)=>x.txId===e.txId && x.args.series!==undefined && id!==null && b(x.args.series)===id);
  const reads=new EvmReads({...ctx,history:async()=>[...prior,e]});
  const core=async()=>record(await ctx.read('Registry','getSeriesCore',[id!]));
  const latestTerms=()=>hist.filter((x)=>x.name==='SeriesCreated'||x.name==='TermsAmended').at(-1);
  const commitment=()=>{const t=latestTerms();if(!t)throw new ChainError('ChainSpecific','series creation history is missing');return String(t.args.termsCommitment??t.args.newTermsCommitment);};
  const issuer=()=>{const x=hist.find((x)=>x.name==='SeriesCreated');if(!x)throw new ChainError('ChainSpecific','series creation history is missing');return addr(x.args.issuer);};
  const status=()=>{const x=hist.filter((x)=>x.name==='StatusChanged'||x.name==='TerminalStatusSet').at(-1);return x?SeriesStatus[n(x.args.newStatus??x.args.status)]!:'OnTime';};
  const payer=async()=>(await ctx.input(e)).sender;
  const window=async()=>record(await ctx.read('Window','getWindow',[id!,num('period')]));
  const windowScope=()=>({...scope,windowId:num('period')});
  const bid=async()=>record(await ctx.read('Auction','getBid',[id!,address('bidder')]));
  const order=async()=>record(await ctx.read('Window','getOrder',[id!,num('period'),address('owner')]));
  const paidWad=()=>{const d=hist.filter((x)=>x.name==='PayoutDistributed' && n(x.args.source)<2).at(-1);return d?str(d.args.paidPerUnitWad):'0';};
  switch(e.name){
    case 'IssuerRegistered':case 'IssuerDeactivated':case 'IssuanceStopped':case 'IssuanceResumed':emit(e.name,{issuer:address('issuer')});break;
    case 'AllowlistUpdated':emit(e.name,{wallet:address('wallet'),allowed:Boolean(a.allowed)});break;
    case 'AttestorRegistered':emit(e.name,{attestor:address('attestor')});break;
    case 'AttestorRevoked':emit(e.name,{attestor:address('attestor'),revokedAt:num('revokedAt')});break;
    case 'VerifierKeyRegistered':emit(e.name,{verifierKey:address('verifierKey')});break;
    case 'VerifierKeyRevoked':emit(e.name,{verifierKey:address('verifierKey'),revokedAt:num('revokedAt')});break;
    case 'FlagsSet':emit('ProtocolFlagsSet',{newRaisesPaused:Boolean(a.newRaisesPaused),windowsEnabled:Boolean(a.windowsEnabled),tier4Enabled:Boolean(a.tier4Enabled)});break;
    case 'FxPairSet':emit('FxPairSet',{pairId:a.pairId,feedId:a.feedId,inverted:Boolean(a.inverted),crosscheck:address('crosscheck')===ZERO20?null:address('crosscheck'),effectivePeriod:fromPid(num('crosscheckEffectivePeriod'))});break;
    case 'ContractHashSet':emit('ContractHashSet',{...scope,contractHash:a.hash});break;
    case 'SeriesCreated':{
      const c={...await core(),termsCommitment:a.termsCommitment,contractHash:ZERO32,tierFlags:a.tierFlags,stablecoin:a.stablecoin,fxPairId:a.fxPairId};
      const original=ctx.read;
      const creationReads=new EvmReads({...ctx,read:(m,f,args)=>m==='Registry'&&f==='getSeriesTerms'?Promise.resolve(a.terms):original(m,f,args)});
      const terms=await creationReads.terms(id!,c,[e]);
      emit('SeriesCreated',{...scope,issuer:address('issuer'),terms});break;
    }
    case 'RaiseOpened':emit('RaiseOpened',{...scope,commitEndsAt:num('commitEnd'),revealEndsAt:num('revealEnd')});break;
    case 'RaiseCancelled':emit('RaiseCancelled',scope);break;
    case 'BidCommitted':{
      const x=await bid(),order=hist.filter((x)=>x.name==='BidCommitted').length;
      emit('BidCommitted',{...scope,bidder:address('bidder'),commitment:String(x.commitment),deposit:s('escrow'),order});break;
    }
    case 'BidRevealed':emit('BidRevealed',{...scope,bidder:address('bidder'),pricePerUnit:s('price'),quantity:s('quantity'),valid:Boolean(a.valid)});break;
    case 'SettlementProposed':emit('SettlementProposed',{...scope,clearingPrice:s('clearingPrice'),round:num('round')});break;
    case 'SettlementRejected':emit('SettlementRejected',{...scope,clearingPrice:s('clearingPrice'),round:num('round'),reason:num('reason')===1?'ClaimMismatch':'InvalidClearingPrice'});break;
    case 'RaiseSettled':emit('AuctionSettled',{...scope,clearingPrice:s('clearingPrice'),unitsSold:s('unitsSold'),proceeds:s('proceeds'),settledAt:num('settlementTs')});break;
    case 'RaiseFailed':emit('AuctionFailed',{...scope,reason:b(a.clearingPrice)===0n?'NoValidBids':'MinRaise',clearingPrice:s('clearingPrice'),unitsSold:b(a.clearingPrice)?(b(a.proceeds)/b(a.clearingPrice)).toString():'0',proceeds:s('proceeds'),minimumRaise:s('minRaise')});break;
    case 'UnitsAllocated':
      emit('UnitsAllocated',{...scope,bidder:address('bidder'),units:s('units'),cost:s('cost'),fee:s('fee'),refund:s('refund')});
      if(b(a.fee))emit('FeeTaken',{...scope,kind:'auction',amount:s('fee'),payer:address('bidder')});break;
    case 'NonRevealCharged':if(b(a.charge)){emit('NonRevealCharged',{...scope,bidder:address('bidder'),charge:s('charge')});emit('FeeTaken',{...scope,kind:'nonReveal',amount:s('charge'),payer:address('bidder')});}break;
    case 'BidDelivered':emit('BidDelivered',{...scope,bidder:address('bidder'),units:s('units'),refund:s('refund')});break;
    case 'RaiseMintFinalized':emit('RaiseMintFinalized',{...scope,unitsSold:s('unitsSold'),proceeds:s('proceeds')});break;
    case 'HolderRegistered':emit('HolderRegistered',{...scope,holder:address('holder')});break;
    case 'ProceedsDeposited':emit('TreasuryFunded',{...scope,amount:s('amount')});break;
    case 'ReleaseClaimed':case 'EarlyDrawExecuted':{
      const schedule=await ctx.read('Registry','getReleaseSchedule',[id!]) as unknown[];
      let start=e.name==='ReleaseClaimed'?b(a.releasedTotal)-b(a.amount):hist.filter((x)=>x.name==='ReleaseClaimed'||x.name==='EarlyDrawExecuted').reduce((sum,x)=>sum+b(x.args.amount),0n),remaining=b(a.amount);
      for(let i=0;i<schedule.length && remaining>0n;i++){
        const tranche=b(await ctx.read('Treasury','trancheAmount',[id!,BigInt(i)]));
        if(start>=tranche){start-=tranche;continue;}
        const available=tranche-start,amount=available<remaining?available:remaining;
        emit('FundsReleased',{...scope,amount:amount.toString(),trancheIndex:i});remaining-=amount;start=0n;
      }
      if(remaining)throw new ChainError('ChainSpecific','release exceeds the recorded tranche schedule');break;
    }
    case 'ReleasePauseSet':break; // Derived below, including lateness hidden by a hardship pause.
    case 'ReportAccepted':{
      const r=record(await ctx.read('Income','getReport',[id!,num('period')]));
      const c=await core();
      emit('ReportAccepted',{...scope,periodId:fromPid(num('period')),tier:num('tier'),paymentDue:s('due'),accrual:'0',priorIncomeCommitment:String(r.priorIncomeCommitment),incomeCommitment:a.incomeCommitment,termsCommitment:commitment(),fxBasis:c.fxPairId===ZERO32?'unity':a.fxFallback?'attestor':'accumulator',fxAvgWad:s('fxAvgWad'),liquidityEvent:Boolean(a.liquidityEvent)});break;
    }
    case 'PayoutDistributed':{
      const source=num('source');
      if(source===3){if(b(a.accepted))emit('PaymentReceived',{...scope,periodId:null,gross:s('accepted'),fee:'0',net:s('netAdded'),source:'extinguishment',paidPerUnitWad:paidWad()});break;}
      if(source===2)break; // tail has TailDistributed
      const payment=same.find((x)=>x.name==='PaymentSettled'),trueup=same.find((x)=>x.name==='TrueUpPaid');
      const periodId=source===1?fromPid(pidAt(BigInt(e.blockTime))):payment?fromPid(n(payment.args.period)):null;
      if(b(a.gross)>b(a.accepted))emit('PaymentRefunded',{...scope,periodId,amount:(b(a.gross)-b(a.accepted)).toString(),reason:'cap'});
      const from=source===1?String(await ctx.read('Router','routerReceiver',[id!])).toLowerCase():await payer();
      if(b(a.fee))emit('FeeTaken',{...scope,kind:'payout',amount:s('fee'),payer:from});
      emit('PaymentReceived',{...scope,periodId,gross:s('accepted'),fee:s('fee'),net:s('netAdded'),source:source===1?'split':'payIn',paidPerUnitWad:s('paidPerUnitWad'),...(payment?{paymentDue:(b(payment.args.gross)-b(payment.args.accrual)).toString(),accrual:str(payment.args.accrual)}:{})});
      if(source===1 && b(a.accepted))emit('SplitReceipt',{...scope,periodId,amount:s('accepted'),router:from});
      void trueup;break;
    }
    case 'PaymentSettled':{
      // A zero-due report settles without a vault distribution. Preserve that fact once.
      if(!same.some((x)=>x.name==='PayoutDistributed'||x.name==='TailDistributed'))emit('PaymentReceived',{...scope,periodId:fromPid(num('period')),gross:s('accepted'),fee:s('fee'),net:(b(a.accepted)-b(a.fee)).toString(),source:'payIn',paidPerUnitWad:paidWad(),paymentDue:(b(a.gross)-b(a.accrual)).toString(),accrual:s('accrual')});break;
    }
    case 'TailDistributed':{
      const periodId=fromPid(num('period')),redemption=hist.find((x)=>x.name==='SeriesRedeemed');if(!redemption)throw new ChainError('ChainSpecific','redemption history is missing');
      if(b(a.refunded))emit('PaymentRefunded',{...scope,periodId,amount:s('refunded'),reason:'cap'});
      if(b(a.fee))emit('FeeTaken',{...scope,kind:'payout',amount:s('fee'),payer:await payer()});
      emit('PaymentReceived',{...scope,periodId,gross:s('accepted'),fee:s('fee'),net:(b(a.accepted)-b(a.fee)).toString(),source:'tail',paidPerUnitWad:paidWad()});
      emit('TailPayout',{...scope,periodId,perUnit:(b(a.accepted)/b(redemption.args.units)).toString(),total:s('accepted')});break;
    }
    case 'PayoutClaimed':emit('PayoutClaimed',{...scope,holder:address('holder'),amount:s('amount'),burnedUnits:s('burnedUnits')});break;
    case 'TailClaimed':emit('TailClaimed',{...scope,holder:address('holder'),amount:s('amount')});break;
    case 'FinalClaimed':emit('FinalClaimed',{...scope,holder:address('holder'),units:s('units'),amount:s('amount')});break;
    case 'SeriesRetired':emit('SeriesRetired',{...scope,paidPerUnitWad:s('paidPerUnitWad')});break;
    case 'SeriesRedeemed':emit('RedemptionOpened',{...scope,pricePerUnit:s('price'),unitsOutstanding:s('units'),deposit:s('deposit'),tailCapPerUnit:(b(a.capRemaining)-b(a.price)).toString(),tailEndsAt:e.blockTime+DEFAULTS.tailSeconds});break;
    case 'RedemptionClaimed':{
      const redemption=hist.find((x)=>x.name==='SeriesRedeemed');if(!redemption)throw new ChainError('ChainSpecific','redemption history is missing');
      const principal=b(a.units)*b(redemption.args.price),pending=b(a.amount)-principal;if(pending<0n)throw new ChainError('ChainSpecific','invalid redemption accounting');
      if(pending)emit('PayoutClaimed',{...scope,holder:address('holder'),amount:pending.toString(),burnedUnits:'0'});
      emit('RedemptionClaimed',{...scope,holder:address('holder'),units:s('units'),amount:principal.toString()});break;
    }
    case 'UnitsBurned':emit('UnitsBurned',{...scope,holder:address('holder'),units:s('units'),reason:({[SeriesStatus.Retired]:'cap',[SeriesStatus.Redeemed]:'redemption',[SeriesStatus.Extinguished]:'extinguishment'} as Record<number,string>)[num('reason')]});break;
    case 'SeriesExtinguished':emit('SeriesExtinguished',{...scope,attestors:[address('attestorA'),address('attestorB')],returnedToHolders:s('unreleased')});break;
    case 'TrueUpRecorded':emit('TrueUpRecorded',{...scope,year:num('year'),adjustment:s('adjustment'),deadline:num('deadline')});break;
    case 'TrueUpPaid':emit('TrueUpPaid',{...scope,amount:s('amount'),accrual:s('accrual')});break;
    case 'FormalNoticeDue':if(a.trueup){const t=hist.filter((x)=>x.name==='TrueUpRecorded').at(-1);if(!t)throw new ChainError('ChainSpecific','true-up history is missing');emit('TrueUpNoticeDue',{...scope,year:n(t.args.year)});}else emit('FormalNoticeDue',{...scope,periodId:fromPid(num('period'))});break;
    case 'PauseRequested':case 'PauseRequestWithdrawn':emit(e.name,{...scope,nonce:s('nonce')});break;
    case 'PauseApproved':emit('PauseApproved',{...scope,attestor:address('attestor'),start:num('start'),until:num('end')});break;
    case 'PauseEnded':{
      const previous=hist.filter((x)=>x.name==='PauseEnded').at(-1);emit('PauseEnded',{...scope,pausedSeconds:num('pausedTotal')-(previous?n(previous.args.pausedTotal):0)});break;
    }
    case 'StatusChanged':{const to=SeriesStatus[num('newStatus')];if(status()!==to)emit('StatusChanged',{...scope,from:status(),to});break;}
    case 'TerminalStatusSet':{
      // Vault terminal transitions do not go through Income._sync's status event.
      const to=SeriesStatus[num('status')];if(status()!==to)emit('StatusChanged',{...scope,from:status(),to});break;
    }
    case 'TermsAmended':{
      const c=await core(),t=await reads.terms(id!,c,[...hist,e]);emit('TermsAmended',{...scope,termsCommitment:a.newTermsCommitment,previousCommitment:commitment(),capMultipleWad:s('newCapMultipleWad'),attestor:address('attestor'),nonce:s('nonce'),...(t.routerTerms?{routerTerms:t.routerTerms}:{})});break;
    }
    case 'IncomeHeld':emit('RouterIncomeHeld',scope);break;
    case 'IncomeRouted':emit('RouterIncomeRouted',scope);break;
    case 'RouterPeriodClosed':emit('RouterPeriodClosed',{...scope,periodId:fromPid(num('period'))});break;
    case 'WindowOpened':emit('TransferWindowOpened',{...windowScope(),periodId:fromPid(num('period')),commitEndsAt:num('commitEnd'),revealEndsAt:num('revealEnd')});break;
    case 'OrderCommitted':emit('WindowOrderCommitted',{...windowScope(),owner:address('owner'),side:num('side')===0?'buy':'sell',commitment:String((await order()).commitment),escrow:s('escrow')});break;
    case 'OrderRevealed':emit('WindowOrderRevealed',{...windowScope(),owner:address('owner'),pricePerUnit:s('price'),quantity:s('quantity'),valid:Boolean(a.valid),revealIndex:n((await order()).revealIndex)});break;
    case 'WindowSettlementProposed':emit('WindowSettlementProposed',{...windowScope(),clearingPrice:a.noMatch?null:s('clearingPrice'),round:num('round')});break;
    case 'WindowSettlementRejected':{
      const proposed=hist.filter((x)=>x.name==='WindowSettlementProposed' && n(x.args.period)===num('period')).at(-1);
      emit('WindowSettlementRejected',{...windowScope(),round:proposed?n(proposed.args.round):0,reason:`Stage1WindowRejection${num('reason')}`});break;
    }
    case 'WindowCleared':case 'WindowNoMatch':{
      const w=await window();emit('TransferWindowCleared',{...windowScope(),clearingPrice:e.name==='WindowNoMatch'?'0':s('clearingPrice'),unitsTransferred:e.name==='WindowNoMatch'?'0':s('matchedUnits'),done:n(w.orderCount)===0});break;
    }
    case 'OrderFilled':{
      const o=await order(),w=await window(),side=num('side')===0?'buy':'sell';
      const view=await reads.getTransferWindow(sid,num('period')),own=view?.orders.find((x)=>x.owner===address('owner'));
      const processed=hist.filter((x)=>x.name==='OrderFilled' && n(x.args.period)===num('period')).length+1;
      emit('WindowOrderProcessed',{...windowScope(),owner:address('owner'),side,fill:s('fill'),pricePerUnit:s('price'),fee:s('fee'),refund:s('refund'),pendingUnits:side==='buy'?s('fill'):(b(o.escrow)-b(a.fill)).toString(),pendingStable:side==='buy'?s('refund'):(b(a.fill)*b(a.price)).toString(),cancelled:own?.cancelled??false,done:processed===n(w.orderCount)});
      if(b(a.fee))emit('FeeTaken',{...scope,kind:'window',amount:s('fee'),payer:address('owner')});break;
    }
    case 'OrderDelivered':emit('WindowOrderDelivered',{...windowScope(),owner:address('owner'),units:s('units'),amount:s('amount')});break;
    case 'FxSnapshot':emit('RateSnapshot',{pair:a.pair,dayIndex:num('day'),rateWad:s('rateWad'),sumWad:s('sumWad'),count:num('count'),confWad:null,publishTime:null});break;
    case 'FxDeviationFlagged':emit('FxFallbackFlagged',{pair:a.pair,periodId:fromPid(num('period')),reason:'deviation'});break;
  }
  if(sid){
    const previous=releaseBlockFromHistory(hist,hist.at(-1)?.blockTime??e.blockTime),next=releaseBlockFromHistory([...hist,{...e,args:a}],e.blockTime);
    if(previous!==next){if(next)emit('ReleasesPaused',{...scope,reason:next});else emit('ReleasesResumed',scope);}
  }
  return out;
}

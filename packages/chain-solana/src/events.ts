import {ChainError,releaseBlockFromHistory,DEFAULTS,parseDomainEvent,makeSeriesId,type DomainEvent,type EventType} from '@merces/domain';
import {SeriesStatus,fromPid,pidAt} from '@merces/math';
import {SYSTEM,pda} from './accounts.ts';
import {hex,bytes,integer,type Row} from './codec.ts';
import type {SolRecord} from './transport.ts';
const ZERO32=`0x${'00'.repeat(32)}`;
import {SolanaReads,b,n,str} from './reads.ts';
const record=(v:unknown)=>v as Row;

/** Slot, transaction position, log position and expansion index define the durable event order. */
export function eventCursor(e:SolRecord,part:number):string{return `${String(e.slot).padStart(20,'0')}:${String(e.transactionIndex).padStart(8,'0')}:${String(e.logIndex).padStart(5,'0')}:${String(part).padStart(3,'0')}`;}
export function canonicalEvent(chain:string,e:SolRecord,part:number,type:EventType,payload:unknown):DomainEvent{
  const seq=e.ordinal*32+part;if(!Number.isSafeInteger(seq)||part>=32)throw new ChainError('ChainSpecific','event sequence exceeds its supported range');
  return parseDomainEvent({chain,cursor:eventCursor(e,part),seq,blockTime:e.blockTime,blockRef:String(e.slot),txId:e.txId,finality:'finalized',type,payload});
}
const camel=(s:string)=>s.replace(/_([a-z])/g,(_all,c:string)=>c.toUpperCase());
function normalized(value:Row):Row{return Object.fromEntries(Object.entries(value).map(([k,v])=>[camel(k),v instanceof Uint8Array?hex(v):v]));}
export async function mapSolanaEvent(reads:SolanaReads,e:SolRecord,all:SolRecord[]):Promise<DomainEvent[]>{
  const a=normalized(e.args),series=String(e.args.series??''),sid=series?makeSeriesId(reads.config.chain,series):'',out:DomainEvent[]=[];
  const emit=(type:EventType,payload:unknown)=>out.push(canonicalEvent(reads.config.chain,e,out.length,type,payload));
  const scope={seriesId:sid},s=(key:string)=>str(a[key]),num=(key:string)=>n(a[key]),address=(key:string)=>String(a[key]);
  const hist=all.filter((x)=>x.ordinal<e.ordinal&&x.args.series===series).map((x)=>({...x,args:normalized(x.args)}));
  const same=all.filter((x)=>x.txId===e.txId&&x.args.series===series).map((x)=>({...x,args:normalized(x.args)}));
  const rawHist=all.filter((x)=>x.ordinal<e.ordinal&&x.args.series===series);
  const core=async()=>{const c=await reads.s(sid);if(!c)throw new ChainError('ChainSpecific','series account is missing');return c;};
  const latestTerms=()=>hist.filter((x)=>x.name==='SeriesCreated'||x.name==='TermsAmended').at(-1);
  const commitment=()=>{const t=latestTerms();if(!t)throw new ChainError('ChainSpecific','series creation history is missing');return String(t.args.termsCommitment??t.args.newTermsCommitment);};
  const status=()=>{const x=hist.filter((x)=>x.name==='StatusChanged'||x.name==='TerminalStatusSet').at(-1);return x?SeriesStatus[n(x.args.new??x.args.status)]!:'OnTime';};
  const input=async(names:string[])=>{const candidates=(await reads.transport.inputs(e.txId)).filter((i)=>i.accounts.series===series&&names.includes(i.name));if(candidates.length!==1)throw new ChainError('ChainSpecific','cannot associate event with its instruction');return candidates[0]!;};
  const payer=async()=>{const call=await input(['pay','pay_trueup','route','tender_units','claim','claim_tail']);return call.accounts.payer??call.accounts.issuer??call.accounts.owner!;};
  const window=async()=>normalized((await reads.transport.account(pda(reads.protocol,'window',series,integer(num('period'),4)),'Window'))!.value);
  const windowScope=()=>({...scope,windowId:num('period')});
  const bid=async()=>normalized((await reads.transport.account(pda(reads.protocol,'bid',series,address('bidder')),'Bid'))!.value);
  const order=async()=>normalized((await reads.transport.account(pda(reads.protocol,'order',series,integer(num('period'),4),address('owner')),'Order'))!.value);
  const paidWad=()=>{const d=hist.filter((x)=>x.name==='PayoutDistributed'&&n(x.args.source)<2).at(-1);return d?str(d.args.paidPerUnitWad):'0';};
  switch(e.name){
    case 'IssuerRegistered':case 'IssuerDeactivated':case 'IssuanceStopped':case 'IssuanceResumed':emit(e.name,{issuer:address('wallet')});break;
    case 'AllowlistUpdated':emit(e.name,{wallet:address('wallet'),allowed:Boolean(a.allowed)});break;
    case 'AttestorRegistered':emit(e.name,{attestor:address('addr')});break;
    case 'AttestorRevoked':emit(e.name,{attestor:address('addr'),revokedAt:num('revokedAt')});break;
    case 'VerifierKeyRegistered':emit(e.name,{verifierKey:address('addr')});break;
    case 'VerifierKeyRevoked':emit(e.name,{verifierKey:address('addr'),revokedAt:num('revokedAt')});break;
    case 'FlagsSet':emit('ProtocolFlagsSet',{newRaisesPaused:Boolean(a.newRaisesPaused),windowsEnabled:Boolean(a.windowsEnabled),tier4Enabled:Boolean(a.tier4Enabled)});break;
    case 'FxPairSet':emit('FxPairSet',{pairId:a.pairId,feedId:a.feedId,inverted:Boolean(a.inverted),crosscheck:address('crosscheck')===SYSTEM?null:address('crosscheck'),effectivePeriod:fromPid(num('crosscheckEffectivePeriod'))});break;
    case 'ContractHashSet':emit('ContractHashSet',{...scope,contractHash:a.hash});break;
    case 'SeriesCreated':{
      const call=await input(['create_series']),args=call.args.args as Row;
      const c={...await core(),...args,...e.args,payout_multiple_k:e.args.k,contract_hash:Buffer.alloc(32)};
      const terms=await reads.terms(series,c,[e]);emit('SeriesCreated',{...scope,issuer:address('issuer'),terms});break;
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
    case 'RaiseSettled':if(n((await core()).mode)===1)emit('CurveGraduated',{...scope,issuePrice:s('clearingPrice'),unitsSold:s('unitsSold'),settledAt:num('settlementTs')});else emit('AuctionSettled',{...scope,clearingPrice:s('clearingPrice'),unitsSold:s('unitsSold'),proceeds:s('proceeds'),settledAt:num('settlementTs')});break;
    case 'RaiseFailed':emit('AuctionFailed',{...scope,reason:b(a.clearingPrice)===0n?'NoValidBids':'MinRaise',clearingPrice:s('clearingPrice'),unitsSold:b(a.clearingPrice)?(b(a.proceeds)/b(a.clearingPrice)).toString():'0',proceeds:s('proceeds'),minimumRaise:s('minRaise')});break;
    case 'UnitsAllocated':
      emit('UnitsAllocated',{...scope,bidder:address('bidder'),units:s('units'),cost:s('cost'),fee:s('fee'),refund:s('refund')});
      if(b(a.cost))emit('TreasuryFunded',{...scope,amount:s('cost')});
      if(b(a.fee))emit('FeeTaken',{...scope,kind:'auction',amount:s('fee'),payer:address('bidder')});break;
    case 'NonRevealCharged':if(b(a.charge)){emit('NonRevealCharged',{...scope,bidder:address('bidder'),charge:s('charge')});emit('FeeTaken',{...scope,kind:'nonReveal',amount:s('charge'),payer:address('bidder')});}break;
    case 'BidDelivered':emit('BidDelivered',{...scope,bidder:address('bidder'),units:s('units'),refund:s('refund')});break;
    case 'RaiseMintFinalized':emit('RaiseMintFinalized',{...scope,unitsSold:s('unitsSold'),proceeds:s('proceeds')});break;
    case 'HolderRegistered':emit('HolderRegistered',{...scope,holder:address('holder')});break;
    case 'ProceedsDeposited':emit('TreasuryFunded',{...scope,amount:s('amount')});break;
    case 'ReleaseClaimed':case 'EarlyDrawExecuted':{
      const tr=await reads.getTreasury(sid);if(!tr)throw new ChainError('ChainSpecific','treasury account missing');
      let start=e.name==='ReleaseClaimed'?b(a.releasedTotal)-b(a.amount):hist.filter((x)=>x.name==='ReleaseClaimed'||x.name==='EarlyDrawExecuted').reduce((sum,x)=>sum+b(x.args.amount),0n),remaining=b(a.amount);
      for(const t of tr.tranches){if(remaining===0n)break;const tranche=BigInt(t.amount);if(start>=tranche){start-=tranche;continue;}const available=tranche-start,amount=available<remaining?available:remaining;emit('FundsReleased',{...scope,amount:amount.toString(),trancheIndex:t.index});remaining-=amount;start=0n;}
      if(remaining)throw new ChainError('ChainSpecific','release exceeds tranche schedule');break;
    }
    case 'ReleasePauseSet':break; // Derived below, including lateness hidden by a hardship pause.
    case 'ReportAccepted':{
      const r=normalized((await reads.transport.account(pda(reads.protocol,'report',series,integer(num('period'),4)),'Report'))!.value);
      const c=await core();
      emit('ReportAccepted',{...scope,periodId:fromPid(num('period')),tier:num('tier'),paymentDue:s('due'),accrual:'0',priorIncomeCommitment:String(r.priorIncomeCommitment),incomeCommitment:a.incomeCommitment,termsCommitment:commitment(),fxBasis:hex(c.fx_pair_id)===ZERO32?'unity':a.fxFallback?'attestor':'accumulator',fxAvgWad:s('fxAvgWad'),liquidityEvent:Boolean(a.liquidityEvent)});break;
    }
    case 'PayoutDistributed':{
      const source=num('source');
      if(source===3){if(b(a.accepted))emit('PaymentReceived',{...scope,periodId:null,gross:s('accepted'),fee:'0',net:s('netAdded'),source:'extinguishment',paidPerUnitWad:paidWad()});break;}
      if(source===2)break; // tail has TailDistributed
      const payment=same.find((x)=>x.name==='PaymentSettled'),trueup=same.find((x)=>x.name==='TrueUpPaid');
      const periodId=source===1?fromPid(pidAt(BigInt(e.blockTime))):payment?fromPid(n(payment.args.period)):null;
      if(b(a.gross)>b(a.accepted))emit('PaymentRefunded',{...scope,periodId,amount:(b(a.gross)-b(a.accepted)).toString(),reason:'cap'});
      const from=source===1?pda(reads.protocol,'router_token',series):await payer();
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
      emit('TailPayout',{...scope,periodId,perUnit:(b(a.accepted)*(n((await core()).mode)===1?1000000n:1n)/b(redemption.args.units)).toString(),total:s('accepted')});break;
    }
    case 'PayoutClaimed':emit('PayoutClaimed',{...scope,holder:address('holder'),amount:s('amount'),burnedUnits:s('burnedUnits')});break;
    case 'TailClaimed':emit('TailClaimed',{...scope,holder:address('holder'),amount:s('amount')});break;
    case 'FinalClaimed':{
      let units=s('units');
      if(n((await core()).mode)!==1){
        const holder=address('holder');
        const asks=hist.filter((x)=>x.name==='OrderCommitted'&&x.args.owner===holder&&n(x.args.side)===1);
        const escrow=asks.filter((x)=>!hist.some((p)=>p.name==='OrderFilled'&&p.args.owner===holder&&p.args.period===x.args.period)).reduce((sum,x)=>sum+b(x.args.escrow),0n);
        const redeemed=hist.some((x)=>x.name==='SeriesRedeemed');
        const principalUnits=hist.filter((x)=>x.name==='RedemptionClaimed'&&x.args.holder===holder).reduce((sum,x)=>sum+b(x.args.units),0n);
        units=((redeemed?principalUnits:b(a.units))+escrow).toString();
      }
      const bundledRedemption=same.filter((x)=>x.name==='RedemptionClaimed'&&x.args.holder===address('holder')&&x.invocation===e.invocation&&x.ordinal<e.ordinal).reduce((sum,x)=>sum+b(x.args.amount),0n);
      const amount=b(a.amount)-bundledRedemption;if(amount<0n)throw new ChainError('ChainSpecific','invalid final claim accounting');
      emit('FinalClaimed',{...scope,holder:address('holder'),units,amount:amount.toString()});break;
    }
    case 'SeriesRetired':emit('SeriesRetired',{...scope,paidPerUnitWad:s('paidPerUnitWad')});break;
    case 'SeriesRedeemed':emit('RedemptionOpened',{...scope,pricePerUnit:s('price'),unitsOutstanding:s('units'),deposit:s('deposit'),tailCapPerUnit:(b(a.capRemaining)-b(a.price)).toString(),tailEndsAt:e.blockTime+DEFAULTS.tailSeconds});break;
    case 'RedemptionClaimed':{
      const c=await core();let fromStake:string|undefined;
      if(n(c.mode)===1){const call=await input(['tender_units']);fromStake=str(call.args.from_stake);}
      const redemption=hist.find((x)=>x.name==='SeriesRedeemed');if(!redemption)throw new ChainError('ChainSpecific','redemption history is missing');
      const principal=b(redemption.args.price)*b(a.units)/(n(c.mode)===1?1000000n:1n),pending=b(a.amount)-principal;
      if(pending<0n)throw new ChainError('ChainSpecific','invalid redemption accounting');
      if(pending)emit('PayoutClaimed',{...scope,holder:address('holder'),amount:pending.toString(),burnedUnits:'0'});
      emit('RedemptionClaimed',{...scope,holder:address('holder'),units:s('units'),amount:principal.toString(),...(fromStake===undefined?{}:{fromStake})});break;
    }
    case 'UnitsBurned':emit('UnitsBurned',{...scope,holder:address('holder'),units:s('units'),reason:['cap','redemption','extinguishment'][num('reason')]});break;
    case 'SeriesExtinguished':emit('SeriesExtinguished',{...scope,attestors:[address('attestorA'),address('attestorB')],returnedToHolders:s('unreleased')});break;
    case 'TrueUpRecorded':emit('TrueUpRecorded',{...scope,year:num('year'),adjustment:s('adjustment'),deadline:num('deadline')});break;
    case 'TrueUpPaid':emit('TrueUpPaid',{...scope,amount:s('amount'),accrual:s('accrual')});break;
    case 'FormalNoticeDue':if(a.trueup){const t=hist.filter((x)=>x.name==='TrueUpRecorded').at(-1);if(!t)throw new ChainError('ChainSpecific','true-up history is missing');emit('TrueUpNoticeDue',{...scope,year:n(t.args.year)});}else emit('FormalNoticeDue',{...scope,periodId:fromPid(num('period'))});break;
    case 'PauseRequested':emit(e.name,{...scope,nonce:s('nonce')});break;
    case 'PauseRequestWithdrawn':emit(e.name,{...scope,nonce:(b(a.nonce)+1n).toString()});break;
    case 'PauseApproved':emit('PauseApproved',{...scope,attestor:address('attestor'),start:num('start'),until:num('end')});break;
    case 'PauseEnded':{
      const previous=hist.filter((x)=>x.name==='PauseEnded').at(-1);emit('PauseEnded',{...scope,pausedSeconds:num('pausedTotal')-(previous?n(previous.args.pausedTotal):0)});break;
    }
    case 'StatusChanged':{const to=SeriesStatus[num('new')];if(status()!==to)emit('StatusChanged',{...scope,from:status(),to});break;}
    case 'TerminalStatusSet':{
      // Vault terminal transitions do not go through Income._sync's status event.
      const to=SeriesStatus[num('status')];if(status()!==to)emit('StatusChanged',{...scope,from:status(),to});break;
    }
    case 'TermsAmended':{
      const c=await core(),opening=n(c.tier_flags)&1?await reads.opening(series,[...rawHist,e]):undefined;
      emit('TermsAmended',{...scope,termsCommitment:a.newTermsCommitment,previousCommitment:commitment(),capMultipleWad:s('newCapMultipleWad'),attestor:address('attestor'),nonce:s('nonce'),...(opening?{routerTerms:opening}:{})});break;
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
    case 'CurveActivated':emit('CurveActivated',{...scope,dbcConfig:address('dbcConfig'),dbcPool:address('dbcPool'),baseMint:address('baseMint'),dbcCreator:address('dbcCreator'),unitsSold:s('unitsSold'),issuePrice:s('clearingPrice')});break;
    case 'CurveProceedsCollected':emit('CurveProceedsCollected',{...scope,migrationFee:s('migrationFee'),surplus:s('surplus'),tradingFee:s('tradingFee'),proceeds:s('proceeds')});if(b(a.migrationFee)+b(a.surplus)>0n)emit('TreasuryFunded',{...scope,amount:(b(a.migrationFee)+b(a.surplus)).toString()});if(b(a.tradingFee))emit('FeeTaken',{...scope,kind:'curveTrading',amount:s('tradingFee'),payer:String((await core()).dbc_pool)});break;
    case 'CurveUnitsSynced':emit('CurveUnitsSynced',{...scope,supply:s('supply'),protocolHeld:s('protocolHeld'),unitsOutstanding:s('unitsOutstanding'),stakedTotal:s('stakedTotal')});break;
    case 'UnitsStaked':case 'UnitsUnstaked':emit(e.name,{...scope,holder:address('holder'),units:s('units'),staked:s('staked')});break;
    case 'FxSnapshot':emit('RateSnapshot',{pair:a.pair,dayIndex:num('day'),rateWad:s('rateWad'),sumWad:s('sumWad'),count:num('count'),confWad:null,publishTime:null});break;
    case 'FxDeviationFlagged':emit('FxFallbackFlagged',{pair:a.pair,periodId:fromPid(num('period')),reason:'deviation'});break;
  }
  if(sid){
    const previous=releaseBlockFromHistory(hist,hist.at(-1)?.blockTime??e.blockTime),next=releaseBlockFromHistory([...hist,{...e,args:a}],e.blockTime);
    if(previous!==next){if(next)emit('ReleasesPaused',{...scope,reason:next});else emit('ReleasesResumed',scope);}
  }
  return out;
}

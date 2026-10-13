import {ChainError,DEFAULTS,KEY_GRACE_SECONDS,ZERO_INCOME_COMMITMENT,makeSeriesId,seriesKeyOf,type AuctionState,type BidState,type IssuerState,type PeriodState,type PositionState,type QuarterRateState,type RateAccumulatorState,type RedemptionState,type RouterState,type SeriesState,type PendingReportingState,type SeriesTerms,type SignerKeyState,type SignerKind,type TransferWindowState,type TreasuryState,type VaultState} from '@merces/domain';
import {SeriesStatus,RaiseState,WAD,fromPid,pidAt,toPid,capPerUnit,lateAccrualTrueup,projectDeadlines,standingOf,statusParamsOf,tradingDaysInPeriod,settlementYear,periodEnd,type LedgerClock} from '@merces/math';
import {ZERO20,ZERO32,seriesNumber,type EvmModule} from './abi.ts';

export type Row=Record<string,unknown>;
export const record=(v:unknown):Row=>v as Row;
export const b=(v:unknown):bigint=>{if(typeof v!=='bigint' && typeof v!=='string' && typeof v!=='number')throw new ChainError('ChainSpecific','invalid ABI integer');return BigInt(v);};
export const n=(v:unknown):number=>{const x=Number(b(v));if(!Number.isSafeInteger(x))throw new ChainError('ChainSpecific','ABI integer exceeds the API range');return x;};
export const str=(v:unknown)=>b(v).toString();
export const addr=(v:unknown)=>String(v).toLowerCase();
export interface EvmRecord {module:EvmModule;name:string;args:Row;blockNumber:bigint;logIndex:number;transactionIndex:number;txId:string;blockTime:number;}
export interface EvmReadContext {
  chain:string;
  now:number;
  stablecoins:Partial<Record<'USDC'|'USDG',string>>;
  fxCurrencies:Record<string,string>;
  read(module:EvmModule,name:string,args?:readonly unknown[]):Promise<unknown>;
  tokenBalance(token:string,wallet:string):Promise<bigint>;
  history():Promise<EvmRecord[]>;
  input(event:EvmRecord):Promise<{name:string;args:readonly unknown[];sender:string}>;
}
const seriesEvents=(all:EvmRecord[],id:bigint)=>all.filter((e)=>e.args.series!==undefined && b(e.args.series)===id);
export class EvmReads {
  constructor(readonly ctx:EvmReadContext){}
  id(sid:string){return seriesNumber(sid,this.ctx.chain);}
  sid(id:bigint){return makeSeriesId(this.ctx.chain,id.toString());}
  async rows(module:EvmModule,name:string,args:unknown[],count:number):Promise<Row[]> {
    const result:Row[]=[];
    for(let i=0;i<count;i+=100)result.push(...(await Promise.all(Array.from({length:Math.min(100,count-i)},(_,j)=>this.ctx.read(module,name,[...args,BigInt(i+j)])))).map(record));
    return result;
  }
  async history(id:bigint):Promise<EvmRecord[]>{return seriesEvents(await this.ctx.history(),id);}
  async core(sid:string):Promise<Row|null>{const id=this.id(sid),count=b(await this.ctx.read('Registry','seriesCount'));return id>count?null:record(await this.ctx.read('Registry','getSeriesCore',[id]));}
  async getIssuer(issuer:string):Promise<IssuerState|null>{
    const i=record(await this.ctx.read('Registry','getIssuer',[issuer]));if(!i.registered)return null;
    const all=await this.ctx.history();
    return {issuer:addr(issuer),registeredAt:all.find((e)=>e.name==='IssuerRegistered' && addr(e.args.issuer)===addr(issuer))?.blockTime??0,active:Boolean(i.active),issuanceStopped:Boolean(i.issuanceStopped),seriesIds:all.filter((e)=>e.name==='SeriesCreated' && addr(e.args.issuer)===addr(issuer)).map((e)=>this.sid(b(e.args.series)))};
  }
  async listSeries():Promise<SeriesState[]>{const count=n(await this.ctx.read('Registry','seriesCount'));const out:SeriesState[]=[];for(let i=1;i<=count;i++) {const s=await this.getSeries(this.sid(BigInt(i)));if(s)out.push(s);}return out;}
  async terms(id:bigint,c:Row,history:EvmRecord[]):Promise<SeriesTerms>{
    const [t,schedule]=await Promise.all([this.ctx.read('Registry','getSeriesTerms',[id]).then(record),this.ctx.read('Registry','getReleaseSchedule',[id]) as Promise<{atOffsetSeconds:bigint;bps:number}[]>]);
    const coin=Object.entries(this.ctx.stablecoins).find(([,value])=>value?.toLowerCase()===addr(c.stablecoin))?.[0] as 'USDC'|'USDG'|undefined;
    if(!coin)throw new ChainError('ChainSpecific','series stablecoin is missing from the deployment catalogue');
    const pair=c.fxPairId===ZERO32?null:String(c.fxPairId);
    const currency=pair?this.ctx.fxCurrencies[pair]: 'USD';
    if(!currency)throw new ChainError('ChainSpecific','reporting currency is missing for the registered FX pair',{pairId:pair});
    const flags=n(c.tierFlags),tierFlags={tier1:!!(flags&1),tier2:!!(flags&2),tier3:!!(flags&4),tier4:!!(flags&8)};
    let routerTerms:SeriesTerms['routerTerms'];
    if(tierFlags.tier1){
      const event=history.filter((e)=>e.name==='SeriesCreated' || e.name==='TermsAmended').at(-1);
      if(!event)throw new ChainError('ChainSpecific','router terms history is missing; verify the deployment start block');
      const input=await this.ctx.input(event),opening=record(input.args[input.name==='createSeries'?7:4]);
      routerTerms={theta:str(opening.theta),rWad:str(opening.rWad),currencyCode:n(opening.currencyCode),indexingRule:n(opening.indexingRule),termsSalt:str(opening.termsSalt)};
    }
    return {stablecoin:coin,stablecoinMint:addr(c.stablecoin),raiseStyle:'sealed',unitsOffered:str(t.unitsOffered),reservePrice:str(t.reservePrice),minimumRaise:str(t.minRaise),capMultipleWad:str(t.capMultipleWad),hurdleWad:str(t.hurdleRateWad),payoutMultipleK:n(t.payoutMultipleK),lockupSeconds:n(t.lockupSeconds),walletCapBps:n(t.walletCapBps),auctionFeeBps:n(t.auctionFeeBps),payoutFeeBps:n(t.payoutFeeBps),windowFeeBps:n(t.windowFeeBps),nonRevealChargeBps:n(t.nonRevealChargeBps),commitDurationSeconds:n(t.commitDuration),revealDurationSeconds:n(t.revealDuration),windowCommitDuration:n(t.windowCommitDuration),windowRevealDuration:n(t.windowRevealDuration),releaseSchedule:schedule.map((r)=>({afterSeconds:n(r.atOffsetSeconds),bps:n(r.bps)})),dueDays:DEFAULTS.dueDays,graceDays:DEFAULTS.graceDays,formalNoticeDays:DEFAULTS.formalNoticeDays,contractHash:String(c.contractHash),termsCommitment:String(c.termsCommitment),fxPairId:pair,reportingCurrency:currency,tierFlags,...(routerTerms?{routerTerms}:{})};
  }
  clock(c:Row,l:Row,pauses:{start:bigint;end:bigint}[]):LedgerClock{return {status:n(l.storedStatus) as SeriesStatus,firstPeriod:b(c.settlementTs)?pidAt(b(c.settlementTs)):0,lastAcceptedPeriod:l.hasAccepted?n(l.lastAcceptedPeriod):null,openDuePeriod:b(l.openDueAmount)?n(l.openDuePeriod):null,openDueAmount:b(l.openDueAmount),pauses,trueupDue:b(l.trueupDue),trueupAttestedAt:b(l.trueupAttestedAt)};}
  async getPendingReportingState(sid:string):Promise<PendingReportingState|null>{
    const c=await this.core(sid);
    if(!c||b(c.settlementTs)!==0n)return null;
    const fxPairId=c.fxPairId===ZERO32?null:String(c.fxPairId);
    const reportingCurrency=fxPairId?this.ctx.fxCurrencies[fxPairId]:'USD';
    if(!reportingCurrency)throw new ChainError('ChainSpecific','reporting currency is missing for the registered FX pair');
    const flags=n(c.tierFlags),status=SeriesStatus[n(await this.ctx.read('Income','deriveStatus',[this.id(sid)]))] as SeriesState['status'];
    return {issuer:addr(c.issuer),now:this.ctx.now,status,terms:{reportingCurrency,fxPairId,tierFlags:{tier1:!!(flags&1),tier2:!!(flags&2),tier3:!!(flags&4),tier4:!!(flags&8)}}};
  }
  async getSeries(sid:string):Promise<SeriesState|null>{
    const c=await this.core(sid);if(!c)return null;const id=this.id(sid);
    const [l,v,tr,pauses,history]=await Promise.all([this.ctx.read('Income','getLedger',[id]).then(record),this.ctx.read('Vault','getLedger',[id]).then(record),this.ctx.read('Treasury','getTreasury',[id]).then(record),this.ctx.read('Income','getPauses',[id]) as Promise<{start:bigint;end:bigint}[]>,this.history(id)]);
    const terms=await this.terms(id,c,history),clock=this.clock(c,l,pauses),params=statusParamsOf(terms);
    const phase=RaiseState[n(c.raiseState)] as SeriesState['phase'];
    const status=SeriesStatus[n(await this.ctx.read('Income','deriveStatus',[id]))] as SeriesState['status'];
    const current=pauses.find((p)=>p.start<=BigInt(this.ctx.now) && BigInt(this.ctx.now)<p.end);
    const trueupAccrual=lateAccrualTrueup(clock,BigInt(this.ctx.now),params);
    const yearGross:SeriesState['yearGross']=Array.from({length:4},()=>({year:null,grossWad:'0'}));
    if(b(c.settlementTs)) {
      // The tagged ring retains untouched old slots and tags zero payments too (MercesVault._addYearGross).
      for(const e of history.filter((e)=>e.name==='PayoutDistributed'&&n(e.args.source)<2)){
        let anchor=BigInt(e.blockTime);
        if(n(e.args.source)===0){const paid=history.find((p)=>p.txId===e.txId&&p.name==='PaymentSettled');const trueup=history.filter((p)=>p.name==='TrueUpRecorded'&&(p.blockNumber<e.blockNumber||p.blockNumber===e.blockNumber&&p.logIndex<e.logIndex)).at(-1);const period=paid?n(paid.args.period):trueup?pidAt(BigInt(trueup.blockTime)):null;if(period===null)throw new ChainError('ChainSpecific','payment anchor history is missing');anchor=periodEnd(period)+BigInt(DEFAULTS.dueDays)*86400n;}
        const year=settlementYear(anchor,b(c.settlementTs));yearGross[year%4]={year,grossWad:'0'};
      }
      for(const slot of yearGross)if(slot.year!==null)slot.grossWad=str(await this.ctx.read('Vault','yearGrossWad',[id,BigInt(slot.year)]));
    }
    const redemption=this.redemption(v,history);
    return {seriesId:sid,chain:this.ctx.chain,issuer:addr(c.issuer),terms,unitScale:'1',phase,status,createdAt:history.find((e)=>e.name==='SeriesCreated')?.blockTime??0,openedAt:n(c.openedAt)||null,settledAt:n(c.settlementTs)||null,issuePrice:b(c.settlementTs)?str(c.clearingPrice):null,unitsSold:str(c.unitsSold),unitsOutstanding:str(v.unitsOutstanding),unitsSyncedAt:null,stakedTotal:'0',tenderedTotal:'0',capPerUnit:b(c.settlementTs)?capPerUnit(BigInt(terms.capMultipleWad),b(c.clearingPrice)).toString():null,paidPerUnitWad:str(v.paidPerUnitWad),accNetWad:str(v.netAccWad),lockupEndsAt:b(c.settlementTs)?n(c.settlementTs)+terms.lockupSeconds:null,releasesPaused:Boolean(tr.issuerPausedReleases)||Boolean(await this.ctx.read('Income','isLateUnderlying',[id])),releasesPausedByIssuer:Boolean(tr.issuerPausedReleases),pause:current?{requestedUntil:null,approvedUntil:n(current.end),startedAt:n(current.start)}:l.pauseRequested?{requestedUntil:null,approvedUntil:null,startedAt:null}:null,pausedSecondsTotal:n(l.pausedTotal),redemption,extinguishedAt:n(v.extinguishedAt)||null,grossPaidTotal:(b(v.grossReceived)+b(v.tailGrossReceived)).toString(),feesTotal:(b(v.feeCollected)+b(v.tailFeeCollected)).toString(),
      reporting:{firstPeriod:clock.firstPeriod?fromPid(clock.firstPeriod):null,nextExpectedPeriod:clock.firstPeriod?fromPid(clock.lastAcceptedPeriod===null?clock.firstPeriod:clock.lastAcceptedPeriod+1):null,lastAcceptedPeriod:clock.lastAcceptedPeriod===null?null:fromPid(clock.lastAcceptedPeriod),lastPaidPeriod:l.hasPaid?fromPid(n(l.lastPaidPeriod)):null,openDuePeriod:clock.openDuePeriod===null?null:fromPid(clock.openDuePeriod),openDueAmount:str(l.openDueAmount),lastIncomePeriod:l.hasIncomeCommitment?fromPid(n(l.lastIncomePeriod)):null,lastIncomeCommitment:l.hasIncomeCommitment?String(l.lastIncomeCommitment):ZERO_INCOME_COMMITMENT},
      pauses:{count:n(l.pauseCount),pausedTotalSeconds:n(l.pausedTotal),requested:Boolean(l.pauseRequested),requestedUntil:null,current:current?{start:n(current.start),end:n(current.end)}:null},formalNoticeEmittedFor:l.hasFormalNotice?fromPid(n(l.formalNoticeEmittedFor)):null,carryWad:str(v.carryWad),refundedToIssuer:str(v.refundedToIssuer),yearGross,final:{accWad:str(v.finalAccWad),units:str(v.finalUnits),distributed:str(v.unreleasedReceived)},seriesKey:seriesKeyOf(sid,'evm'),nonces:{pause:str(l.pauseNonce),amendment:str(c.amendmentNonce),extinguish:str(v.extinguishNonce),trueup:str(l.trueupNonce)},mintFinalized:Boolean(c.mintFinalized),trueUp:{nonce:str(l.trueupNonce),lastYear:l.hasLastTrueupYear?n(l.lastTrueupYear):null,year:l.hasTrueupYear?n(l.trueupYear):null,due:str(l.trueupDue),attestedAt:n(l.trueupAttestedAt)||null,accrual:trueupAccrual.toString(),total:(b(l.trueupDue)+trueupAccrual).toString(),routerCredit:str(l.routerCredit),noticeEmitted:Boolean(l.trueupNoticeEmitted)}};
  }
  redemption(v:Row,history:EvmRecord[]):RedemptionState|null {
    if(!b(v.redemptionTs))return null;
    return {openedAt:n(v.redemptionTs),pricePerUnit:str(v.redemptionPrice),unitsAtRedemption:str(v.unitsAtRedemption),deposit:str(v.redemptionDeposit),claimed:history.filter((e)=>e.name==='RedemptionClaimed').reduce((sum,e)=>sum+b(e.args.units)*b(v.redemptionPrice),0n).toString(),tailCapPerUnit:str(v.tailCapPerUnit),tailEndsAt:n(v.redemptionTs)+DEFAULTS.tailSeconds,tailPaidPerUnit:(b(v.tailPaidPerUnitWad)/WAD).toString(),tailPaidPerUnitWad:str(v.tailPaidPerUnitWad),tailAccWad:str(v.tailAccWad),tailExhausted:Boolean(v.tailExhausted),tailRefunded:str(v.tailRefunded)};
  }
  async getRedemption(sid:string):Promise<RedemptionState|null>{if(!await this.core(sid))return null;const id=this.id(sid);return this.redemption(record(await this.ctx.read('Vault','getLedger',[id])),await this.history(id));}
  async getAuction(sid:string):Promise<AuctionState|null>{
    const c=await this.core(sid);if(!c)return null;const a=record(await this.ctx.read('Auction','getAuction',[this.id(sid)]));
    const state=RaiseState[n(c.raiseState)] as AuctionState['raiseState'];
    return {seriesId:sid,phase:state==='Open' && this.ctx.now>=n(a.commitEnd)?'Reveal':state,raiseState:state,commitEndsAt:n(a.commitEnd)||null,revealEndsAt:n(a.revealEnd)||null,bidCount:n(a.bidCount),revealedCount:n(a.revealedCount),validCount:n(a.validCount),escrowTotal:str(a.escrowTotal),escrowUnits:str(a.escrowUnits),round:n(a.tallyRound),roundRejected:Boolean(a.roundRejected),rejectionReason:a.roundRejected?(n(a.rejectionReason)===1?'ClaimMismatch':'InvalidClearingPrice'):null,proposal:b(a.tallyRound)?{clearingPrice:str(a.proposedPrice),qAboveClaim:str(a.qAboveClaim),qAtClaim:str(a.qAtClaim),rClaim:str(a.rClaim)}:null,tally:{talliedCount:n(a.talliedCount),qAbove:str(a.qAbove),qAt:str(a.qAt),allocSum:str(a.allocSum),minValidPrice:b(a.minValidPrice)===(1n<<64n)-1n?null:str(a.minValidPrice)},clearingPrice:b(a.clearingPrice)?str(a.clearingPrice):null,qAbove:str(a.qAbove),qAt:str(a.qAt),R:str(a.R),unitsSold:str(a.unitsSold),proceeds:str(a.proceeds),finalizedAt:n(a.settlementTs)||null,failureReason:state==='Failed'?(b(a.validCount)?'MinRaise':'NoValidBids'):null,bidsProcessed:n(a.bidsProcessed),unitsMinted:str(a.unitsMinted),mintFinalized:Boolean(a.mintFinalized)};
  }
  async bid(sid:string,x:Row,index:number):Promise<BidState>{
    // Only a processed, unrevealed bid can have a non-reveal charge. Pending bids and
    // revealed bids are complete in the pinned getter, even while event history catches up.
    const charge=x.processed&&!x.revealed?(await this.history(this.id(sid))).find((e)=>e.name==='NonRevealCharged'&&addr(e.args.bidder)===addr(x.bidder)):undefined;
    return {seriesId:sid,bidder:addr(x.bidder),commitment:String(x.commitment),deposit:str(x.escrow),order:index,revealed:x.revealed?{pricePerUnit:str(x.price),quantity:str(x.quantity)}:null,revealIndex:x.revealed?n(x.revealIndex):null,valid:x.revealed?Boolean(x.valid):null,talliedRound:n(x.talliedRound),processed:Boolean(x.processed),allocatedUnits:str(x.allocation),pendingUnits:str(x.pendingUnits),pendingRefund:str(x.pendingRefund),nonRevealCharge:charge?str(charge.args.charge):'0',delivered:Boolean(x.delivered)};
  }
  async listBids(sid:string):Promise<BidState[]>{const a=await this.getAuction(sid);if(!a)return [];const rows=await this.rows('Auction','getBidAt',[this.id(sid)],a.bidCount);return Promise.all(rows.map((x,i)=>this.bid(sid,x,i)));}
  async getBid(sid:string,wallet:string):Promise<BidState|null>{return (await this.listBids(sid)).find((x)=>x.bidder===addr(wallet))??null;}
  async getTreasury(sid:string):Promise<TreasuryState|null>{
    const c=await this.core(sid);if(!c)return null;const id=this.id(sid),settledAt=n(c.settlementTs)||null;
    // Treasury state is fully available from getters at this snapshot's finalized block.
    // Expanding a full series here needlessly waits for every historical protocol event.
    const [tr,schedule,late]=await Promise.all([
      this.ctx.read('Treasury','getTreasury',[id]).then(record),
      this.ctx.read('Registry','getReleaseSchedule',[id]) as Promise<{atOffsetSeconds:bigint;bps:number}[]>,
      this.ctx.read('Income','isLateUnderlying',[id]),
    ]);
    let released=b(tr.releasedTotal);const tranches:TreasuryState['tranches']=[];
    for(const [i,t] of schedule.entries()){const amount=b(await this.ctx.read('Treasury','trancheAmount',[id,BigInt(i)])),afterSeconds=n(t.atOffsetSeconds),drawn=settledAt!==null&&amount>0n&&released>=amount;released=released>amount?released-amount:0n;tranches.push({index:i,afterSeconds,bps:n(t.bps),amount:amount.toString(),drawableAt:settledAt===null?null:settledAt+afterSeconds,drawn});}
    return {seriesId:sid,total:str(tr.deposited),released:str(tr.releasedTotal),balance:(b(tr.deposited)-b(tr.releasedTotal)-b(tr.movedToVault)).toString(),paused:Boolean(tr.issuerPausedReleases)||Boolean(late),tranches};
  }
  async getVault(sid:string):Promise<VaultState|null>{
    if(!await this.core(sid))return null;const id=this.id(sid),v=record(await this.ctx.read('Vault','getLedger',[id]));
    const balance=b(v.grossReceived)-b(v.feeCollected)+b(v.tailGrossReceived)-b(v.tailFeeCollected)+b(v.redemptionDeposit)+b(v.unreleasedReceived)-b(v.claimedTotal);
    let entitled=0n;
    // A zero balance has zero dust regardless of holder entitlements; no log scan is needed.
    for(const p of balance>0n?await this.listPositions(sid):[]){
      const h=record(await this.ctx.read('Vault','getHolder',[id,p.wallet]));
      const tailWeight=BigInt(p.redeemedUnits)+BigInt(p.walletUnits)+BigInt(p.undeliveredUnits);
      const tail=b(v.redemptionTs)?(b(v.tailAccWad)-b(h.lastTailAccWad))*tailWeight/WAD:0n;
      entitled+=BigInt(p.claimable)+BigInt(p.redemptionClaimable)+tail+BigInt(p.finalClaimable);
    }
    return {seriesId:sid,balance:balance.toString(),accNetWad:str(v.netAccWad),grossTotal:(b(v.grossReceived)+b(v.tailGrossReceived)).toString(),feesTotal:(b(v.feeCollected)+b(v.tailFeeCollected)).toString(),dust:(balance>entitled?balance-entitled:0n).toString()};
  }

  async getPosition(sid:string,wallet:string):Promise<PositionState|null>{
    const c=await this.core(sid);if(!c)return null;const id=this.id(sid),h=record(await this.ctx.read('Vault','getHolder',[id,wallet]));
    if(!h.registered)return null;
    const v=record(await this.ctx.read('Vault','getLedger',[id]));
    const [walletUnits,auctionPending,windowPending,askEscrow,units,claimable,tail,final,history]=await Promise.all([
      addr(c.unitToken)===ZERO20?Promise.resolve(0n):this.ctx.tokenBalance(addr(c.unitToken),wallet),this.ctx.read('Auction','pendingUnitsOf',[id,wallet]).then(b),this.ctx.read('Window','pendingUnitsOf',[id,wallet]).then(b),this.ctx.read('Window','askEscrowUnits',[id,wallet]).then(b),this.ctx.read('Vault','accrualUnits',[id,wallet]).then(b),this.ctx.read('Vault','pendingOf',[id,wallet]).then(b),this.ctx.read('Vault','claimableTail',[id,wallet]).then(b),this.ctx.read('Vault','claimableFinal',[id,wallet]).then(b),this.history(id)]);
    const redemptionUnits=walletUnits+auctionPending+windowPending; // The preview includes deliveries required before the burn.
    const redemptionClaimable=b(v.redemptionTs)?b(v.redemptionPrice)*redemptionUnits + b(h.lastTailAccWad)*redemptionUnits/WAD:0n;
    const claimed=history.filter((e)=>addr(e.args.holder)===addr(wallet) && ['PayoutClaimed','TailClaimed','FinalClaimed','RedemptionClaimed'].includes(e.name)).reduce((sum,e)=>sum+b(e.args.amount)-(e.name==='RedemptionClaimed'?b(e.args.units)*b(v.redemptionPrice):0n),0n);
    return {seriesId:sid,wallet:addr(wallet),units:units.toString(),walletUnits:walletUnits.toString(),stakedUnits:'0',undeliveredUnits:(auctionPending+windowPending).toString(),escrowedUnits:askEscrow.toString(),claimable:claimable.toString(),claimedTotal:claimed.toString(),redeemedUnits:str(h.redeemedUnits),redemptionClaimable:redemptionClaimable.toString(),tailClaimable:(b(v.redemptionTs)?(b(v.tailAccWad)-b(h.lastTailAccWad))*(b(h.redeemedUnits)>0n?b(h.redeemedUnits):redemptionUnits)/WAD:0n).toString(),finalClaimable:final.toString(),registered:true,pending:str(h.pending),lastAccWad:str(h.lastNetAccWad)};
  }
  async listPositions(sid:string):Promise<PositionState[]>{
    const holders=[...new Set((await this.history(this.id(sid))).filter((e)=>e.name==='HolderRegistered').map((e)=>addr(e.args.holder)))];
    const positions=await Promise.all(holders.map((h)=>this.getPosition(sid,h)));return positions.filter((p):p is PositionState=>p!==null);
  }
  async getPeriod(sid:string,periodId:string):Promise<PeriodState|null>{
    const c=await this.core(sid);if(!c || !b(c.settlementTs))return null;const id=this.id(sid),p=toPid(periodId);
    const [l,r,t,pauses,history]=await Promise.all([this.ctx.read('Income','getLedger',[id]).then(record),this.ctx.read('Income','getReport',[id,p]).then(record),this.ctx.read('Registry','getSeriesTerms',[id]).then(record),this.ctx.read('Income','getPauses',[id]) as Promise<{start:bigint;end:bigint}[]>,this.history(id)]);
    const clock=this.clock(c,l,pauses),params=statusParamsOf({...DEFAULTS,hurdleWad:str(t.hurdleRateWad)}),deadlines=projectDeadlines(p,pauses,BigInt(this.ctx.now),params);
    const open=b(l.openDueAmount)>0n && n(l.openDuePeriod)===p;
    const accrual=open && !l.openDueIsTail?b(await this.ctx.read('Income','lateAccrual',[id,p,b(l.openDueAmount),BigInt(this.ctx.now)])):b(r.accrualPaid);
    const payments=history.filter((e)=>e.name==='PaymentSettled' && n(e.args.period)===p);
    const paid=payments.reduce((sum,e)=>sum+b(e.args.accepted),0n);
    const split=history.filter((e)=>e.name==='PayoutDistributed' && n(e.args.source)===1 && pidAt(BigInt(e.blockTime))===p).reduce((sum,e)=>sum+b(e.args.accepted),0n);
    const settled=Boolean(r.exists) && b(r.paidAt)>0n;
    return {seriesId:sid,periodId,dueAt:n(deadlines.dueAt),graceEndsAt:n(deadlines.graceEndsAt),formalNoticeAt:n(deadlines.formalNoticeAt),reportAccepted:Boolean(r.exists),tier:r.exists?n(r.tier):null,paymentStable:r.exists?str(r.paymentUsd):'0',paymentDue:(open?b(l.openDueAmount)+accrual:b(r.due)+b(r.accrualPaid)).toString(),accrual:accrual.toString(),paid:paid.toString(),splitReceived:split.toString(),settled,standing:standingOf(p,clock,BigInt(this.ctx.now),params,settled),incomeCommitment:r.exists?String(r.incomeCommitment):null,priorIncomeCommitment:r.exists?String(r.priorIncomeCommitment):null,liquidityEvent:Boolean(r.liquidityEvent)};
  }
  async listPeriods(sid:string):Promise<PeriodState[]>{
    const c=await this.core(sid);if(!c || !b(c.settlementTs))return [];
    const ids=new Set<number>();for(let p=pidAt(b(c.settlementTs));p<pidAt(BigInt(this.ctx.now));p++)ids.add(p);
    for(const e of await this.history(this.id(sid)))if(['ReportAccepted','PaymentSettled','RouterPeriodClosed'].includes(e.name))ids.add(n(e.args.period));
    const out=await Promise.all([...ids].sort((a,b)=>a-b).map((p)=>this.getPeriod(sid,fromPid(p))));return out.filter((p):p is PeriodState=>p!==null);
  }
  async getSignerKey(kind:SignerKind,address:string):Promise<SignerKeyState|null>{
    const k=record(await this.ctx.read('Registry',kind==='attestor'?'attestorKey':'verifierKey',[address]));if(!k.registered)return null;
    const revokedAt=n(k.revokedAt)||null;
    return {kind,address:addr(address),active:Boolean(k.active),revokedAt,graceUntil:revokedAt===null?null:revokedAt+KEY_GRACE_SECONDS};
  }
  async listSignerKeys(kind:SignerKind):Promise<SignerKeyState[]>{
    const event=kind==='attestor'?'AttestorRegistered':'VerifierKeyRegistered',field=kind==='attestor'?'attestor':'verifierKey';
    const addresses=[...new Set((await this.ctx.history()).filter((e)=>e.name===event).map((e)=>addr(e.args[field])))];
    return (await Promise.all(addresses.map((a)=>this.getSignerKey(kind,a)))).filter((k):k is SignerKeyState=>k!==null);
  }
  async getRouter(sid:string):Promise<RouterState|null>{
    const c=await this.core(sid);if(!c || !(n(c.tierFlags)&1))return null;const id=this.id(sid),r=record(await this.ctx.read('Router','getRouter',[id]));
    const receiver=String(await this.ctx.read('Router','routerReceiver',[id])),balance=r.receiverDeployed?await this.ctx.tokenBalance(addr(c.stablecoin),receiver):0n;
    const checkpoints:RouterState['checkpoints']=[];
    if(r.hasCheckpoint && b(c.settlementTs))for(let p=pidAt(b(c.settlementTs));p<=n(r.lastCheckpointPeriod);p++) {
      const cp=await this.ctx.read('Router','ytdAtEnd',[id,p]) as [boolean,bigint];if(cp[0])checkpoints.push({periodId:fromPid(p),ytdAtEnd:cp[1].toString()});
    }
    return {seriesId:sid,receiver:addr(receiver),heldBeforeFinalization:balance.toString(),ytdYear:n(r.ytdYear),ytdReceived:str(r.ytdReceived),nextCheckpointPeriod:r.hasCheckpoint?fromPid(n(r.lastCheckpointPeriod)+1):b(c.settlementTs)?fromPid(pidAt(b(c.settlementTs))):null,checkpoints};
  }
  async getTransferWindow(sid:string,windowId?:number):Promise<TransferWindowState|null>{
    if(!await this.core(sid))return null;const id=this.id(sid);
    if(windowId===undefined){const current=await this.ctx.read('Window','currentWindow',[id]) as [boolean,number];if(!current[0])return null;windowId=n(current[1]);}
    const w=record(await this.ctx.read('Window','getWindow',[id,windowId]));if(!b(w.state))return null;
    const rows=await this.rows('Window','getOrderAt',[id,windowId],n(w.orderCount));
    const orders:TransferWindowState['orders']=rows.map((o)=>({owner:addr(o.owner),side:n(o.side)===0?'buy':'sell',commitment:String(o.commitment),escrow:str(o.escrow),revealed:Boolean(o.revealed),valid:Boolean(o.valid),pricePerUnit:o.revealed?str(o.price):null,quantity:o.revealed?str(o.quantity):null,revealIndex:o.revealed?n(o.revealIndex):-1,talliedRound:n(o.talliedRound),processed:Boolean(o.processed),delivered:Boolean(o.delivered),fill:str(o.fill),pendingUnits:str(o.pendingUnits),pendingStable:str(o.pendingStable),cancelled:Boolean(o.processed && o.revealed && o.valid && n(o.side)===0 && n(w.branch)>0 && b(o.fill)===0n && (b(o.price)>b(w.clearingPrice)?b(o.quantity)>0n:b(o.price)===b(w.clearingPrice) && (n(w.branch)===2?b(o.quantity)>0n:b(w.dAt)>0n && b(o.quantity)*b(w.marginalRemaining)/b(w.dAt)>0n)))}));
    // Cancellation is public in OrderFilled only as fill=0 after a winning bid loses allowlist eligibility.
    const state=(['Commit','Commit','Reveal','Settling','Settled','NoMatch','Done'] as const)[n(w.state)]!;
    return {seriesId:sid,windowId,periodId:fromPid(n(w.period)),state:state==='Commit' && this.ctx.now>=n(w.commitEnd)?'Reveal':state,tallyRound:n(w.tallyRound),roundRejected:Boolean(w.roundRejected),proposal:b(w.tallyRound)&&!w.noMatchProposed?str(w.proposedPrice):null,talliedCount:n(w.talliedCount),branch:n(w.branch)===1?'SupplyLimited':n(w.branch)===2?'DemandLimited':null,matchedUnits:str(w.matchedUnits),accAtClear:str(w.accAtClear),orders,commitEndsAt:n(w.commitEnd),revealEndsAt:n(w.revealEnd),cleared:n(w.state)>=4,clearingPrice:n(w.state)>=4 && b(w.clearingPrice)?str(w.clearingPrice):null,orderCount:n(w.orderCount),escrowStable:str(w.escrowStable),escrowUnits:str(w.escrowUnits)};
  }
  async getRateAccumulator(pair:string):Promise<RateAccumulatorState|null>{
    const config=record(await this.ctx.read('Registry','getFxPair',[pair]));if(!config.exists)return null;
    const a=record(await this.ctx.read('FxAccumulator','getFxPair',[pair]));
    const latest=(await this.ctx.history()).filter((e)=>e.name==='FxSnapshot' && e.args.pair===pair).at(-1);
    return {pair,sumWad:str(a.sumWad),count:n(a.count),lastDayIndex:b(a.count)?n(a.lastDay):null,lastRateWad:latest?str(latest.args.rateWad):null};
  }
  async getQuarterRate(pair:string,periodId:string):Promise<QuarterRateState|null>{
    const config=record(await this.ctx.read('Registry','getFxPair',[pair]));if(!config.exists)return null;
    const [available,ok,avg,count,flagged]=await this.ctx.read('FxAccumulator','quarterStats',[pair,toPid(periodId)]) as [boolean,boolean,bigint,number,boolean];
    const defaults=record(await this.ctx.read('Registry','getDefaults')),days=tradingDaysInPeriod(toPid(periodId)),coverageOk=available && n(count)*10000>=n(days)*n(defaults.fxMinCoverageBps);
    return {pair,periodId,avgWad:available?avg.toString():null,snapshots:n(count),daysInQuarter:n(days),coverageOk,needsFallback:!ok,fallbackReason:flagged?'deviation':!ok?'coverage':null};
  }
}

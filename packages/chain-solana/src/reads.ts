import {PublicKey} from '@solana/web3.js';
import {ChainError,DEFAULTS,KEY_GRACE_SECONDS,ZERO_INCOME_COMMITMENT,parseSeriesId,makeSeriesId,seriesKeyOf,type ChainPort,type SeriesState,type SeriesTerms,type PositionState,type RedemptionState,type TransferWindowState,type RouterState,type SignerKind} from '@merces/domain';
import {SeriesStatus,RaiseState,WAD,fromPid,toPid,pidAt,deriveStatus,isLateUnderlying,lateAccrual,lateAccrualTrueup,projectDeadlines,standingOf,statusParamsOf,capPerUnit,quarterAverage,DEFAULT_PARAMETERS,tradingDaysInPeriod,settleHolderDelta,type LedgerClock} from '@merces/math';
import {bytes,hex,integer,type Row} from './codec.ts';
import {SYSTEM,TOKEN_2022,pda,programOf,ata} from './accounts.ts';
import type {SolanaTransport,SolRecord} from './transport.ts';
import type {SolanaChainConfig} from './config.ts';
export const b=(v:unknown):bigint=>BigInt((v??0) as bigint|number|string);
export const n=(v:unknown):number=>{const x=Number(v??0);if(!Number.isSafeInteger(x))throw new ChainError('ChainSpecific','chain integer exceeds the API range');return x;};
export const str=(v:unknown)=>b(v).toString();
const array=(v:unknown)=>v as unknown[];
const hash=(v:unknown)=>v===undefined?`0x${'00'.repeat(32)}`:hex(v);
const sum=(events:SolRecord[],name:string,field:string)=>events.filter((e)=>e.name===name).reduce((total,e)=>total+b(e.args[field]),0n);
export class SolanaReads {
  readonly registry:string;readonly protocol:string;
  constructor(readonly config:SolanaChainConfig,readonly transport:SolanaTransport,readonly now:number){this.registry=programOf(config,'registry');this.protocol=programOf(config,'protocol');}
  address(sid:string):string{const p=parseSeriesId(sid);if(p.chain!==this.config.chain)throw new ChainError('InvalidTerms','series belongs to another chain');return new PublicKey(p.address).toBase58();}
  sid(address:string){return makeSeriesId(this.config.chain,address);}
  async s(sid:string){return (await this.transport.account(this.address(sid),'Series'))?.value??null;}
  async row(prefix:string,series:string,type:string):Promise<Row>{return (await this.transport.account(pda(this.protocol,prefix,series),type))?.value??{};}
  async history(series:string):Promise<SolRecord[]>{return (await this.transport.history()).filter((e)=>e.args.series===series);}
  async getIssuer(wallet:string):ReturnType<ChainPort['getIssuer']>{
    const a=await this.transport.account(pda(this.registry,'issuer',wallet),'Issuer');if(!a)return null;
    const h=await this.transport.history();return {issuer:wallet,active:Boolean(a.value.active),issuanceStopped:Boolean(a.value.issuance_stopped),registeredAt:h.find((e)=>e.name==='IssuerRegistered'&&e.args.wallet===wallet)?.blockTime??0,seriesIds:(await this.transport.scan('registry','Series')).filter((s)=>s.value.issuer===wallet).map((s)=>this.sid(s.address))};
  }
  async listSeries():ReturnType<ChainPort['listSeries']>{const out:SeriesState[]=[];for(const a of await this.transport.scan('registry','Series')){const s=await this.getSeries(this.sid(a.address));if(s)out.push(s);}return out;}
  async opening(series:string,h:SolRecord[]):Promise<SeriesTerms['routerTerms']>{
    const event=h.filter((e)=>e.name==='SeriesCreated'||e.name==='TermsAmended').at(-1);if(!event)throw new ChainError('ChainSpecific','series terms history is missing; verify the start slot');
    const calls=(await this.transport.inputs(event.txId)).filter((i)=>i.accounts.series===series&&['create_series','amend_terms'].includes(i.name));
    const call=event.name==='SeriesCreated'?calls.find((i)=>i.name==='create_series'):calls.filter((i)=>i.name==='amend_terms'&&hash(i.args.new_terms_commitment)===hash(event.args.new_terms_commitment)).at(-1);
    const raw=call?.name==='create_series'?(call.args.args as Row)?.tier1_terms:call?.args.new_tier1_terms;
    if(!raw)throw new ChainError('ChainSpecific','public router terms opening is unavailable');const r=raw as Row;
    return {theta:str(r.theta),rWad:str(r.r_wad),currencyCode:n(r.currency_code),indexingRule:n(r.indexing_rule),termsSalt:BigInt(hash(r.terms_salt)).toString()};
  }
  async terms(series:string,s:Row,h:SolRecord[]):Promise<SeriesTerms>{
    const stablecoin=Object.entries(this.config.stablecoins).find(([,mint])=>mint===s.stablecoin)?.[0] as 'USDC'|'USDG'|undefined;if(!stablecoin)throw new ChainError('ChainSpecific','series stablecoin is missing from the deployment catalogue');
    const pair=hash(s.fx_pair_id),fxPairId=BigInt(pair)===0n?null:pair,currency=fxPairId?this.config.fxCurrencies?.[fxPairId]:'USD';if(!currency)throw new ChainError('ChainSpecific','reporting currency is missing for the registered FX pair',{pairId:fxPairId});
    const flags=n(s.tier_flags),tierFlags={tier1:!!(flags&1),tier2:!!(flags&2),tier3:!!(flags&4),tier4:!!(flags&8)};
    return {stablecoin,stablecoinMint:String(s.stablecoin),unitsOffered:str(s.units_offered),reservePrice:str(s.reserve_price),minimumRaise:str(s.min_raise),capMultipleWad:str(s.cap_multiple_wad),lockupSeconds:n(s.lockup_seconds),releaseSchedule:(s.release_schedule as Row[]).map((t)=>({afterSeconds:n(t.at_offset_seconds),bps:n(t.bps)})),auctionFeeBps:n(s.auction_fee_bps),payoutFeeBps:n(s.payout_fee_bps),hurdleWad:str(s.hurdle_rate_wad),payoutMultipleK:n(s.payout_multiple_k),walletCapBps:n(s.wallet_cap_bps),nonRevealChargeBps:n(s.non_reveal_charge_bps),commitDurationSeconds:n(s.commit_duration),revealDurationSeconds:n(s.reveal_duration),windowCommitDuration:n(s.window_commit_duration),windowRevealDuration:n(s.window_reveal_duration),windowFeeBps:n(s.window_fee_bps),dueDays:DEFAULTS.dueDays,graceDays:DEFAULTS.graceDays,formalNoticeDays:DEFAULTS.formalNoticeDays,contractHash:hash(s.contract_hash),termsCommitment:hash(s.terms_commitment),tierFlags,fxPairId,reportingCurrency:currency,raiseStyle:n(s.mode)===1?'curve':'sealed',...(tierFlags.tier1?{routerTerms:await this.opening(series,h)}:{})};
  }
  clock(l:Row):LedgerClock{
    const pauses=Array.from({length:n(l.pause_count)},(_,i)=>({start:b(array(l.pause_start)[i]),end:b(array(l.pause_end)[i])}));
    return {status:n(l.status),firstPeriod:n(l.first_period),lastAcceptedPeriod:l.has_last_accepted_period?n(l.last_accepted_period_v):null,openDuePeriod:l.has_open_due_period?n(l.open_due_period_v):null,openDueAmount:b(l.open_due_amount),pauses,trueupDue:b(l.trueup_due),trueupAttestedAt:b(l.trueup_attested_at)};
  }
  async getSeries(sid:string):ReturnType<ChainPort['getSeries']>{
    const s=await this.s(sid);if(!s)return null;const address=this.address(sid);
    const [l,tr,h]=await Promise.all([this.row('ledger',address,'Ledger'),this.row('treasury',address,'Treasury'),this.history(address)]);
    const terms=await this.terms(address,s,h),clock=this.clock(l),params=statusParamsOf(terms),phase=RaiseState[n(s.raise_state)] as SeriesState['phase'];
    const status=SeriesStatus[phase==='Settled'?deriveStatus(clock,BigInt(this.now),params):n(l.status)] as SeriesState['status'];
    const current=clock.pauses.find((p)=>p.start<=BigInt(this.now)&&BigInt(this.now)<p.end),trueup=lateAccrualTrueup(clock,BigInt(this.now),params);
    const tailGross=sum(h,'TailDistributed','accepted'),tailFee=sum(h,'TailDistributed','fee');
    const first=b(s.settlement_ts)?n(l.first_period):null;
    return {seriesId:sid,chain:this.config.chain,issuer:String(s.issuer),terms,unitScale:n(s.mode)===1?'1000000':'1',phase,status,createdAt:h.find((e)=>e.name==='SeriesCreated')?.blockTime??0,openedAt:n(s.opened_at)||null,settledAt:n(s.settlement_ts)||null,issuePrice:b(s.settlement_ts)||n(s.mode)===1&&s.unit_mint!==SYSTEM?str(s.clearing_price):null,unitsSold:str(s.units_sold),unitsOutstanding:str(l.units_outstanding),unitsSyncedAt:n(l.units_synced_at)||null,stakedTotal:str(l.staked_total),tenderedTotal:str(l.tendered_total),capPerUnit:b(s.settlement_ts)||n(s.mode)===1?capPerUnit(b(s.cap_multiple_wad),b(s.clearing_price)).toString():null,paidPerUnitWad:str(l.paid_per_unit_wad),accNetWad:str(l.net_acc_wad),lockupEndsAt:b(s.settlement_ts)?n(s.settlement_ts)+n(s.lockup_seconds):null,releasesPaused:Boolean(tr.issuer_paused_releases)||(phase==='Settled'&&isLateUnderlying(clock,BigInt(this.now),params)),releasesPausedByIssuer:Boolean(tr.issuer_paused_releases),pause:current?{requestedUntil:null,approvedUntil:n(current.end),startedAt:n(current.start)}:l.pause_requested?{requestedUntil:null,approvedUntil:null,startedAt:null}:null,pausedSecondsTotal:n(l.paused_total),redemption:this.redemption(sid,s,l,h),extinguishedAt:n(l.extinguished_at)||null,grossPaidTotal:(b(l.gross_received)+tailGross).toString(),feesTotal:(b(l.fee_collected)+tailFee).toString(),
      reporting:{firstPeriod:first===null?null:fromPid(first),nextExpectedPeriod:first===null?null:fromPid(clock.lastAcceptedPeriod===null?first:clock.lastAcceptedPeriod+1),lastAcceptedPeriod:clock.lastAcceptedPeriod===null?null:fromPid(clock.lastAcceptedPeriod),lastPaidPeriod:l.has_last_paid_period?fromPid(n(l.last_paid_period_v)):null,openDuePeriod:clock.openDuePeriod===null?null:fromPid(clock.openDuePeriod),openDueAmount:str(l.open_due_amount),lastIncomePeriod:l.has_last_income_period?fromPid(n(l.last_income_period_v)):null,lastIncomeCommitment:l.has_last_income_period?hash(l.last_income_commitment):ZERO_INCOME_COMMITMENT},
      pauses:{count:n(l.pause_count),pausedTotalSeconds:n(l.paused_total),requested:Boolean(l.pause_requested),requestedUntil:null,current:current?{start:n(current.start),end:n(current.end)}:null},formalNoticeEmittedFor:l.has_formal_notice?fromPid(n(l.formal_notice_emitted_for_v)):null,carryWad:str(l.carry_wad),refundedToIssuer:str(l.refunded_to_issuer),yearGross:Array.from({length:4},(_,i)=>({year:array(l.year_gross_set??[])[i]?n(array(l.year_gross_tag)[i]):null,grossWad:str(array(l.year_gross_wad??[])[i])})),final:{accWad:str(l.final_acc_wad),units:str(l.final_units),distributed:sum(h,'SeriesExtinguished','unreleased').toString()},seriesKey:seriesKeyOf(sid,'solana'),nonces:{pause:str(l.pause_nonce),amendment:str(s.amendment_nonce),extinguish:str(l.extinguish_nonce),trueup:str(l.trueup_nonce)},mintFinalized:Boolean(s.mint_finalized),trueUp:{nonce:str(l.trueup_nonce),lastYear:l.has_last_trueup_year?n(l.last_trueup_year_v):null,year:l.has_trueup_year?n(l.trueup_year_v):null,due:str(l.trueup_due),attestedAt:b(l.trueup_due)?n(l.trueup_attested_at):null,accrual:trueup.toString(),total:(b(l.trueup_due)+trueup).toString(),routerCredit:str(l.router_credit),noticeEmitted:Boolean(l.trueup_notice_emitted)}};
  }
  redemption(_sid:string,s:Row,l:Row,h:SolRecord[]):RedemptionState|null{
    if(!b(l.redemption_ts))return null;const scale=n(s.mode)===1?1000000n:1n;
    return {openedAt:n(l.redemption_ts),pricePerUnit:str(l.redemption_price),unitsAtRedemption:str(l.units_at_redemption),deposit:(b(l.redemption_price)*b(l.units_at_redemption)/scale).toString(),claimed:h.filter((e)=>e.name==='RedemptionClaimed').reduce((sum,e)=>sum+b(e.args.units)*b(l.redemption_price)/scale,0n).toString(),tailCapPerUnit:str(l.tail_cap_per_unit),tailEndsAt:n(l.redemption_ts)+DEFAULTS.tailSeconds,tailPaidPerUnit:(b(l.tail_paid_per_unit_wad)*scale/WAD).toString(),tailPaidPerUnitWad:str(l.tail_paid_per_unit_wad),tailAccWad:str(l.tail_acc_wad),tailExhausted:Boolean(l.tail_exhausted),tailRefunded:sum(h,'TailDistributed','refunded').toString()};
  }
  async getRedemption(sid:string):ReturnType<ChainPort['getRedemption']>{const s=await this.s(sid);if(!s)return null;const a=this.address(sid);return this.redemption(sid,s,await this.row('ledger',a,'Ledger'),await this.history(a));}
  async getAuction(sid:string):ReturnType<ChainPort['getAuction']>{
    const s=await this.s(sid);if(!s)return null;const address=this.address(sid),a=await this.row('auction',address,'Auction'),h=await this.history(address),state=RaiseState[n(s.raise_state)] as 'Draft'|'Open'|'Settling'|'Settled'|'Failed'|'Cancelled';
    const proposed=h.filter((e)=>e.name==='SettlementProposed').at(-1);
    const pending=(await this.listBids(sid)).reduce((sum,b)=>sum+BigInt(b.pendingUnits),0n);
    return {seriesId:sid,phase:state==='Open'&&b(a.commit_end)>0n&&this.now>=n(a.commit_end)?'Reveal':state,raiseState:state,commitEndsAt:n(a.commit_end)||null,revealEndsAt:n(a.reveal_end)||null,bidCount:n(a.bid_count),revealedCount:n(a.revealed_count),validCount:n(a.valid_count),escrowTotal:str(a.escrow_total),escrowUnits:pending.toString(),round:n(a.tally_round),roundRejected:Boolean(a.round_rejected),rejectionReason:a.round_rejected?(n(a.rejection_reason)===1?'ClaimMismatch':'InvalidClearingPrice'):null,proposal:proposed?{clearingPrice:str(proposed.args.clearing_price),qAboveClaim:str(a.q_above_claim),qAtClaim:str(a.q_at_claim),rClaim:str(a.r_claim)}:null,tally:{talliedCount:n(a.tallied_count),qAbove:str(a.q_above),qAt:str(a.q_at),allocSum:str(a.alloc_sum),minValidPrice:b(a.min_valid_price)===(1n<<64n)-1n?null:str(a.min_valid_price)},clearingPrice:['Settled','Failed'].includes(state)&&b(a.clearing_price)?str(a.clearing_price):null,qAbove:str(a.q_above),qAt:str(a.q_at),R:str(a.r_claim),unitsSold:str(a.units_sold??s.units_sold),proceeds:str(a.proceeds),finalizedAt:n(a.settlement_ts??s.settlement_ts)||null,failureReason:state==='Failed'?(b(a.valid_count)?'MinRaise':'NoValidBids'):null,bidsProcessed:n(a.bids_processed),unitsMinted:str(a.units_minted),mintFinalized:Boolean(s.mint_finalized)};
  }
  async listBids(sid:string):ReturnType<ChainPort['listBids']>{
    const address=this.address(sid),h=await this.history(address),commits=h.filter((e)=>e.name==='BidCommitted');
    return (await this.transport.scan('protocol','Bid')).filter((a)=>a.value.series===address).map(({value:x})=>({seriesId:sid,bidder:String(x.bidder),commitment:hash(x.commitment),deposit:str(x.escrow),order:commits.findIndex((e)=>e.args.bidder===x.bidder),revealed:x.revealed?{pricePerUnit:str(x.price),quantity:str(x.quantity)}:null,revealIndex:x.revealed?n(x.reveal_index):null,valid:x.revealed?Boolean(x.valid):null,talliedRound:n(x.tallied_round),processed:Boolean(x.processed),allocatedUnits:str(x.allocation),pendingUnits:str(x.pending_units),pendingRefund:str(x.pending_refund),nonRevealCharge:sum(h.filter((e)=>e.args.bidder===x.bidder),'NonRevealCharged','charge').toString(),delivered:Boolean(x.delivered)})).sort((a,b)=>a.order-b.order);
  }
  async getBid(sid:string,wallet:string):ReturnType<ChainPort['getBid']>{return (await this.listBids(sid)).find((b)=>b.bidder===wallet)??null;}
  async getTreasury(sid:string):ReturnType<ChainPort['getTreasury']>{
    const s=await this.getSeries(sid);if(!s)return null;const a=this.address(sid),t=await this.row('treasury',a,'Treasury');let assigned=0n,released=b(t.released_total);
    const tranches=s.terms.releaseSchedule.map((tr,index)=>{const amount=index===s.terms.releaseSchedule.length-1?b(t.proceeds)-assigned:b(t.proceeds)*BigInt(tr.bps)/10000n;assigned+=amount;const drawn=s.settledAt!==null&&amount>0n&&released>=amount;released=released>amount?released-amount:0n;return {index,...tr,amount:amount.toString(),drawableAt:s.settledAt===null?null:s.settledAt+tr.afterSeconds,drawn};});
    return {seriesId:sid,total:str(t.proceeds_received),released:str(t.released_total),balance:(await this.transport.tokenBalance(pda(this.protocol,'treasury_token',a))).toString(),paused:s.releasesPaused,tranches};
  }
  async getPosition(sid:string,wallet:string):ReturnType<ChainPort['getPosition']>{
    const s=await this.s(sid);if(!s)return null;const address=this.address(sid),curve=n(s.mode)===1;
    const [holder,l,h,walletUnits]=await Promise.all([this.transport.account(pda(this.protocol,'holder',address,wallet),'Holder'),this.row('ledger',address,'Ledger'),this.history(address),String(s.unit_mint)===SYSTEM?Promise.resolve(0n):this.transport.tokenBalance(ata(wallet,String(s.unit_mint),TOKEN_2022))]);
    if(!holder&&(!curve||walletUnits===0n))return null;const p=holder?.value??{},registered=Boolean(p.registered),scale=curve?1000000n:1n;
    const auction=b(p.undelivered_units),window=b(p.window_pending_units),escrow=b(p.ask_escrow_units),stake=b(p.staked_units),base=walletUnits+auction+window,weight=curve?stake:base+escrow;
    const delta=(acc:unknown,last:unknown,units:bigint)=>settleHolderDelta(b(acc),b(last),units);
    let claimable=b(p.pending);
    if(registered){
      if(curve){claimable+=delta(l.net_acc_wad,p.last_net_acc_wad,stake);if(!b(l.redemption_ts))claimable+=delta(l.final_acc_wad,p.last_final_acc_wad,stake);}
      else if(escrow>0n&&l.window_cleared){const snap=b(l.window_acc_at_clear),last=b(p.last_net_acc_wad);claimable+=last<snap?delta(snap,last,weight)+delta(l.net_acc_wad,snap,base):delta(l.net_acc_wad,last,base);}
      else claimable+=delta(l.net_acc_wad,p.last_net_acc_wad,weight);
    }
    const redeemable=base,redeemed=b(p.redeemed_units),isRedeemed=b(l.redemption_ts)>0n;
    const quota=b(l.units_at_redemption)-b(l.tendered_total)-b(l.staked_total),fromWallet=walletUnits<quota?walletUnits:quota>0n?quota:0n;
    const redemptionClaimable=isRedeemed?(curve?b(l.redemption_price)*(stake+fromWallet)/scale:b(l.redemption_price)*redeemable+delta(p.last_tail_acc_wad,0n,redeemable)):0n;
    const tail=isRedeemed?delta(l.tail_acc_wad,p.last_tail_acc_wad,curve?redeemed:redeemed>0n?redeemed:redeemable):0n;
    const final=n(l.status)===SeriesStatus.Extinguished&&registered?(curve?!isRedeemed?0n:delta(l.final_acc_wad,p.last_final_acc_wad,redeemed):delta(l.final_acc_wad,p.last_final_acc_wad,(isRedeemed?redeemed:0n)+weight)):0n;
    const claimed=h.filter((e)=>e.args.holder===wallet&&['PayoutClaimed','TailClaimed','FinalClaimed','RedemptionClaimed'].includes(e.name)).reduce((sum,e)=>{
      const includedRedemption=e.name==='FinalClaimed'?h.filter((r)=>r.name==='RedemptionClaimed'&&r.txId===e.txId&&r.invocation===e.invocation&&r.ordinal<e.ordinal&&r.args.holder===wallet).reduce((x,r)=>x+b(r.args.amount),0n):0n;
      return sum+b(e.args.amount)-includedRedemption-(e.name==='RedemptionClaimed'?b(e.args.units)*b(l.redemption_price)/scale:0n);
    },0n);
    return {seriesId:sid,wallet,units:weight.toString(),walletUnits:walletUnits.toString(),stakedUnits:stake.toString(),undeliveredUnits:(auction+window).toString(),escrowedUnits:escrow.toString(),claimable:claimable.toString(),claimedTotal:claimed.toString(),redeemedUnits:redeemed.toString(),redemptionClaimable:redemptionClaimable.toString(),tailClaimable:tail.toString(),finalClaimable:final.toString(),registered,pending:str(p.pending),lastAccWad:str(p.last_net_acc_wad)};
  }
  async listPositions(sid:string):ReturnType<ChainPort['listPositions']>{const holders=(await this.transport.scan('protocol','Holder')).filter((a)=>a.value.series===this.address(sid));const positions=await Promise.all(holders.map((a)=>this.getPosition(sid,String(a.value.wallet))));return positions.filter((p):p is PositionState=>p!==null);}
  async getVault(sid:string):ReturnType<ChainPort['getVault']>{
    const s=await this.getSeries(sid);if(!s)return null;const address=this.address(sid),l=await this.row('ledger',address,'Ledger'),balance=await this.transport.tokenBalance(pda(this.protocol,'vault_token',address));let entitled=0n;
    for(const p of await this.listPositions(sid)){
      entitled+=BigInt(p.claimable)+BigInt(p.finalClaimable);
      if(s.terms.raiseStyle==='curve'){entitled+=BigInt(p.tailClaimable);continue;}
      const h=(await this.transport.account(pda(this.protocol,'holder',address,p.wallet),'Holder'))!.value;
      const tailWeight=BigInt(p.redeemedUnits)+BigInt(p.walletUnits)+BigInt(p.undeliveredUnits);
      const tail=s.redemption?settleHolderDelta(b(l.tail_acc_wad),b(h.last_tail_acc_wad),tailWeight):0n;
      entitled+=BigInt(p.redemptionClaimable)+tail;
    }
    if(s.terms.raiseStyle==='curve'&&s.redemption)entitled+=BigInt(s.redemption.deposit)-BigInt(s.redemption.claimed);
    return {seriesId:sid,balance:balance.toString(),accNetWad:str(l.net_acc_wad),grossTotal:s.grossPaidTotal,feesTotal:s.feesTotal,dust:(balance>entitled?balance-entitled:0n).toString()};
  }
  async getPeriod(sid:string,periodId:string):ReturnType<ChainPort['getPeriod']>{
    const s=await this.s(sid);if(!s||!b(s.settlement_ts))return null;const address=this.address(sid),period=toPid(periodId);
    const [l,report,h]=await Promise.all([this.row('ledger',address,'Ledger'),this.transport.account(pda(this.protocol,'report',address,integer(period,4)),'Report'),this.history(address)]);
    const r=report?.value??{},clock=this.clock(l),params=statusParamsOf({...DEFAULTS,hurdleWad:str(s.hurdle_rate_wad)}),deadlines=projectDeadlines(period,clock.pauses,BigInt(this.now),params);
    const open=clock.openDuePeriod===period&&clock.openDueAmount>0n,tail=b(l.redemption_ts)>0n&&b(r.accepted_at)>=b(l.redemption_ts);
    const accrual=open&&!tail?lateAccrual(period,clock.openDueAmount,clock,BigInt(this.now),params):b(r.accrual_paid),settled=Boolean(report)&&b(r.paid_at)>0n;
    const payments=h.filter((e)=>e.name==='PaymentSettled'&&n(e.args.period)===period),split=h.filter((e)=>e.name==='PayoutDistributed'&&n(e.args.source)===1&&pidAt(BigInt(e.blockTime))===period).reduce((sum,e)=>sum+b(e.args.accepted),0n);
    return {seriesId:sid,periodId,dueAt:n(deadlines.dueAt),graceEndsAt:n(deadlines.graceEndsAt),formalNoticeAt:n(deadlines.formalNoticeAt),reportAccepted:Boolean(report),tier:report?n(r.tier):null,paymentStable:str(r.payment_usd),paymentDue:(open?clock.openDueAmount+accrual:b(r.due)+b(r.accrual_paid)).toString(),accrual:accrual.toString(),paid:payments.reduce((sum,e)=>sum+b(e.args.accepted),0n).toString(),splitReceived:split.toString(),settled,standing:standingOf(period,clock,BigInt(this.now),params,settled),incomeCommitment:report?hash(r.income_commitment):null,priorIncomeCommitment:report?hash(r.prior_income_commitment):null,liquidityEvent:Boolean(r.liquidity_event)};
  }
  async listPeriods(sid:string):ReturnType<ChainPort['listPeriods']>{
    const s=await this.s(sid);if(!s||!b(s.settlement_ts))return [];const ids=new Set<number>();for(let p=pidAt(b(s.settlement_ts));p<pidAt(BigInt(this.now));p++)ids.add(p);
    for(const r of await this.transport.scan('protocol','Report'))if(r.value.series===this.address(sid))ids.add(n(r.value.period));
    const out=await Promise.all([...ids].sort((a,b)=>a-b).map((p)=>this.getPeriod(sid,fromPid(p))));return out.filter((p):p is NonNullable<typeof p>=>p!==null);
  }
  async isAllowlisted(wallet:string):Promise<boolean>{return Boolean((await this.transport.account(pda(this.registry,'allow',wallet),'AllowlistEntry'))?.value.allowed);}
  async getSignerKey(kind:SignerKind,address:string):ReturnType<ChainPort['getSignerKey']>{const a=await this.transport.account(pda(this.registry,kind==='attestor'?'attestor':'verifier',bytes(address,20)),kind==='attestor'?'AttestorKey':'VerifierKey');if(!a)return null;const revokedAt=n(a.value.revoked_at)||null;return {kind,address:address.toLowerCase(),active:Boolean(a.value.active),revokedAt,graceUntil:revokedAt===null?null:revokedAt+KEY_GRACE_SECONDS};}
  async listSignerKeys(kind:SignerKind):ReturnType<ChainPort['listSignerKeys']>{const keys=await this.transport.scan('registry',kind==='attestor'?'AttestorKey':'VerifierKey');const out=await Promise.all(keys.map((k)=>this.getSignerKey(kind,hex(k.value.addr))));return out.filter((k):k is NonNullable<typeof k>=>k!==null);}
  async getRouter(sid:string):ReturnType<ChainPort['getRouter']>{
    const s=await this.s(sid);if(!s||!(n(s.tier_flags)&1))return null;const address=this.address(sid),r=await this.transport.account(pda(this.protocol,'router',address),'Router'),receiver=pda(this.protocol,'router_token',address);
    if(!r)return {seriesId:sid,receiver,heldBeforeFinalization:'0',ytdYear:0,ytdReceived:'0',nextCheckpointPeriod:b(s.settlement_ts)?fromPid(pidAt(b(s.settlement_ts))):null,checkpoints:[]};
    const v=r.value,checkpoints:RouterState['checkpoints']=[];for(let i=0;i<8;i++)if(array(v.cp_set)[i])checkpoints.push({periodId:fromPid(n(array(v.cp_period)[i])),ytdAtEnd:str(array(v.cp_ytd_at_end)[i])});
    return {seriesId:sid,receiver,heldBeforeFinalization:(await this.transport.tokenBalance(receiver)).toString(),ytdYear:n(v.ytd_year),ytdReceived:str(v.ytd_received),nextCheckpointPeriod:fromPid(n(v.last_checkpoint_period)?n(v.last_checkpoint_period)+1:n(v.init_period)),checkpoints:checkpoints.sort((a,b)=>a.periodId.localeCompare(b.periodId))};
  }
  async getTransferWindow(sid:string,windowId?:number):ReturnType<ChainPort['getTransferWindow']>{
    const address=this.address(sid);if(!await this.s(sid))return null;
    if(windowId===undefined){const windows=(await this.transport.scan('protocol','Window')).filter((a)=>a.value.series===address).sort((a,b)=>n(b.value.period)-n(a.value.period));if(!windows.length)return null;windowId=n(windows[0]!.value.period);}
    const a=await this.transport.account(pda(this.protocol,'window',address,integer(windowId,4)),'Window');if(!a)return null;const w=a.value;
    const h=await this.history(address),clear=h.filter((e)=>e.name==='WindowCleared'&&n(e.args.period)===windowId).at(-1),latestDist=clear?h.filter((e)=>e.name==='PayoutDistributed'&&e.ordinal<clear.ordinal&&n(e.args.source)<2):[];
    const accAtClear=latestDist.reduce((sum,e)=>sum+b(e.args.delta_acc_wad),0n);
    const rawOrders=(await this.transport.scan('protocol','Order')).filter((a)=>a.value.series===address&&n(a.value.period)===windowId);
    const sortedBids=rawOrders.filter((a)=>a.value.revealed&&n(a.value.side)===0).sort((a,b)=>n(a.value.reveal_index)-n(b.value.reveal_index));
    let marginal=n(w.branch)===1?b(w.matched_units)-b(w.d_above):0n;const cancelled=new Map<string,boolean>();
    for(const {value:o} of sortedBids){let fill=0n;if(o.valid&&b(o.price)>=b(w.clearing_price)){fill=b(o.quantity);if(n(w.branch)===1&&b(o.price)===b(w.clearing_price)){fill=fill<marginal?fill:marginal;marginal-=fill;}}cancelled.set(String(o.owner),Boolean(o.processed&&fill>0n&&b(o.fill)===0n&&n(w.state)!==5));}
    const orders:TransferWindowState['orders']=rawOrders.map(({value:o})=>({owner:String(o.owner),side:n(o.side)===0?'buy':'sell',commitment:hash(o.commitment),escrow:str(o.escrow),revealed:Boolean(o.revealed),valid:Boolean(o.valid),pricePerUnit:o.revealed?str(o.price):null,quantity:o.revealed?str(o.quantity):null,revealIndex:o.revealed?n(o.reveal_index):-1,talliedRound:n(o.tallied_round),processed:Boolean(o.processed),delivered:Boolean(o.delivered),fill:str(o.fill),pendingUnits:str(o.pending_units),pendingStable:str(o.pending_stable),cancelled:cancelled.get(String(o.owner))??false}));
    const done=n(w.state)>=4&&n(w.processed_count)===n(w.order_count),state=done?'Done':(['Commit','Commit','Reveal','Settling','Settled','NoMatch'] as const)[n(w.state)]!;
    return {seriesId:sid,windowId,periodId:fromPid(windowId),state:state==='Commit'&&this.now>=n(w.commit_end)?'Reveal':state,tallyRound:n(w.tally_round),roundRejected:Boolean(w.round_rejected),proposal:n(w.tally_round)&&!w.no_match_proposed?str(w.clearing_price):null,talliedCount:n(w.tallied_count),branch:n(w.branch)===1?'SupplyLimited':n(w.branch)===2?'DemandLimited':null,matchedUnits:str(w.matched_units),accAtClear:accAtClear.toString(),orders,commitEndsAt:n(w.commit_end),revealEndsAt:n(w.reveal_end),cleared:n(w.state)>=4,clearingPrice:n(w.state)>=4&&b(w.clearing_price)?str(w.clearing_price):null,orderCount:n(w.order_count),escrowStable:str(w.escrow_stable),escrowUnits:str(w.escrow_units)};
  }
  async getRateAccumulator(pair:string):ReturnType<ChainPort['getRateAccumulator']>{
    const cfg=await this.transport.account(pda(this.registry,'fx',bytes(pair,32)),'FxPairConfig');if(!cfg)return null;
    const a=(await this.transport.account(pda(this.protocol,'fxpair',bytes(pair,32)),'FxPair'))?.value??{};
    const latest=(await this.transport.history()).filter((e)=>e.name==='FxSnapshot'&&hash(e.args.pair)===pair).at(-1);
    return {pair,sumWad:str(a.sum_wad),count:n(a.count),lastDayIndex:b(a.count)?n(a.last_day):null,lastRateWad:latest?str(latest.args.rate_wad):null};
  }
  async getQuarterRate(pair:string,periodId:string):ReturnType<ChainPort['getQuarterRate']>{
    const acc=await this.getRateAccumulator(pair);if(!acc)return null;const period=toPid(periodId),checkpoints=new Map<number,{sumWad:bigint;count:number;flagged:boolean}>();
    for(const p of [period,period+1]){const c=await this.transport.account(pda(this.protocol,'fxcp',bytes(pair,32),integer(p,4)),'FxCheckpoint');if(c)checkpoints.set(p,{sumWad:b(c.value.sum_wad),count:n(c.value.count),flagged:Boolean(c.value.flagged)});}
    const cfg=(await this.transport.account(pda(this.registry,'config'),'ProtocolConfig'))!.value,defaults=cfg.defaults as Row;
    const q=quarterAverage({sumWad:BigInt(acc.sumWad),count:acc.count,lastDay:BigInt(acc.lastDayIndex??-1),checkpoints},period,{...DEFAULT_PARAMETERS,fxMinCoverageBps:n(defaults.fx_min_coverage_bps)},BigInt(this.now)),days=n(tradingDaysInPeriod(period));
    return {pair,periodId,avgWad:q.avgWad?.toString()??null,snapshots:q.n,daysInQuarter:days,coverageOk:q.avgWad!==null&&q.n*10000>=days*n(defaults.fx_min_coverage_bps),needsFallback:!q.ok,fallbackReason:q.flagged?'deviation':q.ok?null:'coverage'};
  }
  async getBalance(wallet:string,coin:'USDC'|'USDG'):Promise<string>{const mint=this.config.stablecoins[coin];if(!mint)return '0';const account=await this.transport.raw(mint);if(!account)throw new ChainError('NotFound','stablecoin mint is missing');return (await this.transport.tokenBalance(ata(wallet,mint,account.owner.toBase58()))).toString();}
}

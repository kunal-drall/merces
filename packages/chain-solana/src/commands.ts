import {PublicKey,TransactionInstruction,type AccountMeta} from '@solana/web3.js';
import {createTransferCheckedInstruction,unpackMint,getTransferHook,addExtraAccountMetasForExecute} from '@solana/spl-token';
import {encodeProofForSolana} from '@merces/circuits';
import {ChainError,reportPublicInputs,parseSeriesId,type Command,type ChainPort,type SeriesTerms} from '@merces/domain';
import {toPid,pidAt,fxPairId} from '@merces/math';
import {bytes,hex,integer,instruction,idlOf,type Row,type SolModule} from './codec.ts';
import {SYSTEM,TOKEN_2022,ata,createAta,meta,pda,programOf,resolveAccounts,seriesPda,unitHookAccounts} from './accounts.ts';
import type {SolanaTransport,SolAccount} from './transport.ts';
import type {SolanaChainConfig} from './config.ts';
export interface SolPlan {instructions:TransactionInstruction[];preparations?:{summary:string;instructions:TransactionInstruction[]}[];}
export interface SolCurveBuilder {instructions(command:Command,signer:string):Promise<SolPlan>;}
export interface SolCommandContext {config:SolanaChainConfig;transport:SolanaTransport;reads:ChainPort;curve:SolCurveBuilder;now:number;}
const b=(v:unknown)=>BigInt(v as string|number|bigint);
const rt=(t:SeriesTerms['routerTerms'])=>t?{theta:t.theta,r_wad:t.rWad,currency_code:t.currencyCode,indexing_rule:t.indexingRule,terms_salt:`0x${BigInt(t.termsSalt).toString(16).padStart(64,'0')}`}:null;
const zero20=`0x${'00'.repeat(20)}`,zero32=`0x${'00'.repeat(32)}`;
const tierBits=(t:SeriesTerms['tierFlags'])=>[t.tier1,t.tier2,t.tier3,t.tier4].reduce((a,v,i)=>a+(v?1<<i:0),0);
export async function planSolCommand(ctx:SolCommandContext,cmd:Command,signer:string):Promise<SolPlan>{
  const {config,transport}=ctx,registry=programOf(config,'registry'),protocol=programOf(config,'protocol');
  let series:string|undefined,s:Row|undefined;
  if('seriesId' in cmd){const parsed=parseSeriesId(cmd.seriesId);if(parsed.chain!==config.chain)throw new ChainError('InvalidTerms','series belongs to another chain');series=new PublicKey(parsed.address).toBase58();s=(await transport.account(series,'Series'))?.value;if(!s)throw new ChainError('NotFound','series not found');}
  const cfg=(await transport.account(pda(registry,'config'),'ProtocolConfig'))?.value;if(!cfg)throw new ChainError('ChainSpecific','protocol configuration is missing');
  const ledger=series?(await transport.account(pda(protocol,'ledger',series),'Ledger'))?.value:undefined;
  const rows:Record<string,Row>={config:cfg,...(s?{series:s}:{}),...(ledger?{ledger}:{})};
  const known:Record<string,string|null>={payer:signer,keeper:signer,admin:signer,allowlist_manager:signer,issuer_wallet:signer,owner:signer,bidder:signer,holder_wallet:signer,config:pda(registry,'config'),...(series?{series}:{}),...(s?{issuer:String(s.issuer),stablecoin_mint:String(s.stablecoin),stablecoin_program:String(s.stablecoin_program),unit_mint:String(s.unit_mint)===SYSTEM?pda(protocol,'unit_mint',series!):String(s.unit_mint),base_mint:String(s.base_mint),dbc_pool:String(s.dbc_pool),dbc_config:String(s.dbc_config)}:{})};
  if('bidder' in cmd)known.bidder=cmd.bidder;
  if('owner' in cmd)known.owner=cmd.owner;
  if(cmd.kind==='burnRetired')known.holder_wallet=cmd.holder;
  if('windowId' in cmd){
    known.window=pda(protocol,'window',series!,integer(cmd.windowId,4));rows.window={period:cmd.windowId};
    if(cmd.kind!=='deliverOrder'&&cmd.kind!=='clearTransferWindow'&&(!ledger?.has_active_window||Number(ledger.active_window_v)!==cmd.windowId))throw new ChainError('WrongPhase','window changed; rebuild the transaction');
  }
  known.bidder_allowlist=pda(registry,'allow',known.bidder!);known.owner_allowlist=pda(registry,'allow',known.owner!);
  if(s){
    const mint=known.stablecoin_mint!,token=known.stablecoin_program!,unit=known.unit_mint!;
    for(const owner of ['payer','bidder','issuer','owner','holder_wallet'] as const){const w=known[owner]!;known[`${owner==='holder_wallet'?'holder':owner}_stable`]=ata(w,mint,token);known[`${owner==='holder_wallet'?'holder':owner}_stable_ata`]=ata(w,mint,token);}
    for(const owner of ['bidder','owner','holder_wallet'] as const)known[`${owner==='holder_wallet'?'holder':owner}_unit_ata`]=ata(known[owner]!,unit,TOKEN_2022);
    known.auction_escrow_ata=ata(pda(protocol,'auction_escrow',series!),unit,TOKEN_2022);
    known.window_escrow_ata=ata(pda(protocol,'window_escrow',series!),unit,TOKEN_2022);
    known.fee_collector_ata=ata(String(cfg.fee_collector),mint,token);known.fee_collector_token=known.fee_collector_ata;
    if(String(s.base_mint)!==SYSTEM){known.owner_base_ata=ata(known.owner!,String(s.base_mint),TOKEN_2022);known.stake_vault=ata(pda(protocol,'curve_stake',series!),String(s.base_mint),TOKEN_2022);}
  }
  const resolve=(module:SolModule,name:string,args:Row,over:Record<string,string|null>={})=>resolveAccounts(config,module,name,args,{...known,...over},rows);
  const ix=async(module:SolModule,name:string,args:Row={},over:Record<string,string|null>={},remaining:AccountMeta[]=[]):Promise<TransactionInstruction>=>{
    const accounts=resolve(module,name,args,over);
    const value=instruction(module,programOf(config,module),name,args,accounts,remaining);
    if(s&&['commit_ask','deliver_bid','deliver_order'].includes(name))value.keys.push(...unitHookAccounts(config,series!,known.unit_mint!));
    // Token-2022 stablecoins may require hook accounts. Resolve the union for every stablecoin transfer in the call.
    if(s&&['commit_bid','window_commit_bid','pay','pay_trueup','claim_release','process_bid','deliver_bid','process_order','deliver_order','redeem','claim','claim_tail','claim_redemption','claim_final','extinguish','route','tender_units','collect_curve_proceeds'].includes(name))await stableHookAccounts(ctx,value,accounts,s,cmd,signer);
    return value;
  };
  const one=async(module:SolModule,name:string,args:Row={},over:Record<string,string|null>={})=>({instructions:[await ix(module,name,args,over)]});
  switch(cmd.kind){
    case 'createSeries':{
      if(cmd.seriesAddressHint)throw new ChainError('NotPermitted','fixed series addresses are simulator-only');
      const t=cmd.terms,defaults=cfg.defaults as Row;
      for(const [field,key] of [['auctionFeeBps','auction_fee_bps'],['payoutFeeBps','payout_fee_bps'],['windowFeeBps','window_fee_bps'],['nonRevealChargeBps','non_reveal_charge_bps']] as const)if(t[field]!==Number(defaults[key]))throw new ChainError('InvalidTerms','draft fees differ from protocol defaults; refresh the draft',{field});
      series=seriesPda(config,b(cfg.series_count));known.series=series;known.stablecoin_mint=t.stablecoinMint;
      const args={units_offered:t.unitsOffered,reserve_price:t.reservePrice,min_raise:t.minimumRaise,cap_multiple_wad:t.capMultipleWad,hurdle_rate_wad:t.hurdleWad,payout_multiple_k:t.payoutMultipleK,lockup_seconds:t.lockupSeconds,wallet_cap_bps:t.walletCapBps,commit_duration:t.commitDurationSeconds,reveal_duration:t.revealDurationSeconds,window_commit_duration:t.windowCommitDuration,window_reveal_duration:t.windowRevealDuration,release_schedule:t.releaseSchedule.map((r)=>({at_offset_seconds:r.afterSeconds,bps:r.bps})),terms_commitment:t.termsCommitment,tier_flags:tierBits(t.tierFlags),fx_pair_id:t.fxPairId??zero32,mode:t.raiseStyle==='curve'?1:0,issuer_accepts_public_price:t.raiseStyle==='curve',metadata_uri:'',tier1_terms:rt(t.routerTerms)};
      const create=await ix('registry','create_series',{args},{fx_pair:t.fxPairId?pda(registry,'fx',bytes(t.fxPairId)):null});
      const hash=await ix('registry','set_contract_hash',{hash:t.contractHash});return {instructions:[create,hash]};
    }
    case 'setContractHash':return one('registry','set_contract_hash',{hash:cmd.contractHash});
    case 'openRaise':{
      if(Number(s!.mode)===1)return ctx.curve.instructions(cmd,signer);
      const instructions=[await ix('protocol','open_raise')];
      if(!await transport.account(pda(protocol,'auction',series!),'Auction'))return {instructions,preparations:[{summary:'Prepare raise accounts',instructions:[await ix('protocol','prepare_raise')]}]};return {instructions};
    }
    case 'cancelRaise':return one('protocol','cancel_raise');
    case 'commitBid':return one('protocol','commit_bid',{commitment:cmd.commitment,escrow:cmd.deposit});
    case 'revealBid':return one('protocol','reveal_bid',{price:cmd.pricePerUnit,quantity:cmd.quantity,salt:cmd.salt});
    case 'beginSettlement':return one('protocol','begin_settlement',{clearing_price:cmd.clearingPrice,q_above_claim:cmd.qAboveClaim,q_at_claim:cmd.qAtClaim});
    case 'tallyBids':{
      const auction=(await transport.account(pda(protocol,'auction',series!),'Auction'))!.value;
      const bids=(await transport.scan('protocol','Bid')).filter((a)=>a.value.series===series&&a.value.revealed&&a.value.tallied_round!==auction.tally_round).sort((a,b)=>Number(a.value.reveal_index)-Number(b.value.reveal_index)).slice(0,Math.min(cmd.maxBids??24,24));
      if(!bids.length)throw new ChainError('WrongPhase','all revealed bids are already tallied');return {instructions:[await ix('protocol','tally_bids',{}, {},bids.map((a)=>meta(a.address,true)))]};
    }
    case 'finalizeSettlement':return one('protocol','finalize_settlement');
    case 'processBid':return one('protocol','process_bid');
    case 'deliverBid':{
      const holder=pda(protocol,'holder',series!,cmd.bidder);return one('protocol','deliver_bid',{}, {holder:await transport.account(holder,'Holder')?holder:null});
    }
    case 'registerHolder':return one('protocol','register_holder',{wallet:cmd.wallet});
    case 'drawRelease':return one('protocol','claim_release');
    case 'pauseReleases':return one('protocol','set_release_pause',{paused:cmd.paused});
    case 'submitReport':{
      if(cmd.proof.system!=='groth16-bn254')throw new ChainError('InvalidProof','mock proofs are refused on live chains');
      // Stage 1 income.rs proof step: tail reports bind units_at_redemption, including already tendered units.
      const signals=reportPublicInputs({...cmd,termsCommitment:hex(s!.terms_commitment),unitsOutstanding:String(Number(ledger?.status)===5?ledger!.units_at_redemption:ledger?.units_outstanding??0)});
      if(JSON.stringify(signals)!==JSON.stringify(cmd.proof.publicInputs))throw new ChainError('InvalidProof','proof public inputs differ from the live series');
      const proof=encodeProofForSolana(cmd.proof.proof,cmd.proof.publicInputs).proof;
      return one('protocol','submit_report',{args:{period:toPid(cmd.periodId),payment_usd:cmd.paymentStable,fx_avg_wad:cmd.fxAvgWad,fx_fallback_sig:cmd.fxFallback?.signature??null,fx_attestor_addr:cmd.fxFallback?.signer??zero20,prior_income_commitment:cmd.priorIncomeCommitment,income_commitment:cmd.incomeCommitment,tier:cmd.tier,liquidity_event:cmd.liquidityEvent,proof,attestation_sig:cmd.attestation?.signature??null,attestation_addr:cmd.attestation?.signer??zero20}},{attestation_key:cmd.attestation?pda(registry,cmd.tier===2?'verifier':'attestor',bytes(cmd.attestation.signer,20)):SYSTEM,fx_attestor_key:cmd.fxFallback?pda(registry,'attestor',bytes(cmd.fxFallback.signer,20)):SYSTEM,router:cmd.tier===1?pda(protocol,'router',series!):null});
    }
    case 'payIn':{
      const period=Number(ledger?.open_due_period_v),current=await ctx.reads.getPeriod(cmd.seriesId,cmd.periodId??`${Math.floor(period/4)}Q${period%4+1}`);
      if(cmd.periodId&&toPid(cmd.periodId)!==period)throw new ChainError('InvalidTerms','requested period is not the open due');
      if(cmd.amount!==undefined&&cmd.amount!==current?.paymentDue)throw new ChainError('InvalidTerms','payment preview changed; refresh the amount');
      return one('protocol','pay',{}, {report:ledger?.has_open_due_period?pda(protocol,'report',series!,integer(period,4)):null});
    }
    case 'payTrueUp':return one('protocol','pay_trueup',{}, {report:null});
    case 'submitTrueUp':return one('protocol','submit_trueup',{year:cmd.year,adjustment:cmd.adjustment,attestation_ts:cmd.attestationTs,attestor_addr:cmd.attestor,attestor_sig:cmd.signature},{attestor_key:pda(registry,'attestor',bytes(cmd.attestor,20))});
    case 'claimPayout':case 'claimTail':case 'claimFinal':case 'claimRedemption':{
      const method={claimPayout:'claim',claimTail:'claim_tail',claimFinal:'claim_final',claimRedemption:'claim_redemption'}[cmd.kind];
      const instructions=[createAta(signer,signer,String(s!.stablecoin),String(s!.stablecoin_program)),createAta(signer,signer,known.unit_mint!,TOKEN_2022),await ix('protocol',method)];
      const holder=(await transport.account(pda(protocol,'holder',series!,signer),'Holder'))?.value;
      const preparations:NonNullable<SolPlan['preparations']>=[];
      if((cmd.kind==='claimRedemption'||cmd.kind==='claimFinal'||cmd.kind==='claimTail')&&Number(s!.mode)===0&&holder){
        if(b(holder.undelivered_units)>0n){const plan=await planSolCommand(ctx,{kind:'deliverBid',seriesId:cmd.seriesId,bidder:signer},signer);preparations.push({summary:'Deliver auction units before burning them',instructions:plan.instructions});}
        if(b(holder.window_pending_units)>0n){const orders=(await transport.scan('protocol','Order')).filter((a)=>a.value.series===series&&a.value.owner===signer&&a.value.processed&&!a.value.delivered&&b(a.value.pending_units)>0n);for(const a of orders){const plan=await planSolCommand(ctx,{kind:'deliverOrder',seriesId:cmd.seriesId,windowId:Number(a.value.period),owner:signer},signer);preparations.push({summary:'Deliver window units before burning them',instructions:plan.instructions});}}
        if(b(holder.ask_escrow_units)>0n&&ledger?.window_cleared)throw new ChainError('WrongStatus','process the cleared ask before claiming redemption or final share',{stage1:'DeliverFirst'});
      }
      return {instructions,...(preparations.length?{preparations}:{})};
    }
    case 'burnRetired':return one('protocol','burn_retired');
    case 'retireIfCapped':return one('protocol','retire_if_capped');
    case 'requestPause':return one('protocol','request_pause');
    case 'withdrawPauseRequest':return one('protocol','withdraw_pause_request');
    case 'endPause':return one('protocol','end_pause');
    case 'approvePause':return one('protocol','approve_pause',{pause_end:cmd.pauseEnd,attestor_addr:cmd.attestor,attestor_sig:cmd.signature},{attestor_key:pda(registry,'attestor',bytes(cmd.attestor,20))});
    case 'amendTerms':return one('registry','amend_terms',{new_terms_commitment:cmd.termsCommitment,new_cap_multiple_wad:cmd.capMultipleWad,new_tier1_terms:rt(cmd.routerTerms),attestor_addr:cmd.attestor,attestor_sig:cmd.signature});
    case 'extinguish':return one('protocol','extinguish',{attestor_a:cmd.attestorA,sig_a:cmd.signatureA,attestor_b:cmd.attestorB,sig_b:cmd.signatureB},{attestor_key_a:pda(registry,'attestor',bytes(cmd.attestorA,20)),attestor_key_b:pda(registry,'attestor',bytes(cmd.attestorB,20))});
    case 'redeem':if(cmd.maxPricePerUnit!==undefined)throw new ChainError('NotPermitted','Stage 1 redeem has no onchain slippage parameter; rebuild without maxPricePerUnit');if(Number(s!.mode)===1)return ctx.curve.instructions(cmd,signer);return one('protocol','redeem');
    case 'transferUnits':throw new ChainError('NotPermitted','direct unit transfers are forbidden',{stage1:'DirectTransferForbidden'});
    case 'routeIncome':case 'sweepRouter':case 'closeRouterPeriod':{
      const router=pda(protocol,'router',series!),exists=await transport.account(router,'Router');
      const preparations=exists?[]:[{summary:'Initialize income router',instructions:[await ix('protocol','init_router')]}];
      if(cmd.kind==='closeRouterPeriod')return {instructions:[await ix('protocol','close_router_period',{period:toPid(cmd.periodId)})],preparations};
      const instructions:TransactionInstruction[]=[];
      if(cmd.kind==='routeIncome'){
        const from=new PublicKey(known.payer_stable!),mint=new PublicKey(String(s!.stablecoin)),to=new PublicKey(pda(protocol,'router_token',series!)),owner=new PublicKey(signer),amount=BigInt(cmd.amount);
        const transfer=createTransferCheckedInstruction(from,mint,to,owner,amount,Number(s!.stablecoin_decimals),[],new PublicKey(String(s!.stablecoin_program)));
        if(s!.stablecoin_program===TOKEN_2022){const raw=await transport.raw(mint.toBase58());if(!raw)throw new ChainError('NotFound','stablecoin mint missing');const hook=getTransferHook(unpackMint(mint,raw,new PublicKey(TOKEN_2022)));if(hook&&!hook.programId.equals(PublicKey.default))await addExtraAccountMetasForExecute(transport.connection,transfer,hook.programId,from,mint,to,owner,amount,'finalized');}
        if(transfer.keys.some((k)=>k.isSigner&&!k.pubkey.equals(owner)))throw new ChainError('NotPermitted','stablecoin hook requires an additional wallet signer');
        instructions.push(transfer);
      }
      if(cmd.kind==='sweepRouter'||s!.mint_finalized||Number(s!.raise_state)>=5)instructions.push(await ix('protocol','route'));
      return {instructions,preparations};
    }
    case 'openWindow':return one('protocol','open_window',{period:toPid(cmd.periodId)});
    case 'commitWindowOrder':return cmd.side==='buy'?one('protocol','window_commit_bid',{commitment:cmd.commitment,escrow:cmd.deposit}):one('protocol','commit_ask',{commitment:cmd.commitment,units:cmd.units});
    case 'revealWindowOrder':return one('protocol','reveal_order',{price:cmd.pricePerUnit,quantity:cmd.quantity,salt:cmd.salt});
    case 'beginWindowSettlement':return one('protocol','begin_window_settlement',{clearing_price:cmd.clearingPrice??'0',no_match:cmd.clearingPrice===null});
    case 'tallyWindow':{
      const w=(await transport.account(known.window!,'Window'))!.value;
      const orders=(await transport.scan('protocol','Order')).filter((a)=>a.value.series===series&&Number(a.value.period)===cmd.windowId&&a.value.revealed&&a.value.tallied_round!==w.tally_round).slice(0,Math.min(cmd.maxOrders,24));
      if(!orders.length)throw new ChainError('WrongPhase','all revealed orders are already tallied');return {instructions:[await ix('protocol','tally_orders',{}, {},orders.map((a)=>meta(a.address,true)))]};
    }
    case 'finalizeWindow':return one('protocol','finalize_window');
    case 'processOrder':{
      const w=(await transport.account(known.window!,'Window'))!.value;
      const orders=(await transport.scan('protocol','Order')).filter((a)=>a.value.series===series&&Number(a.value.period)===cmd.windowId);
      const remaining=await takebackPreparations(w,orders,ix);
      return {instructions:[await ix('protocol','process_order')],preparations:remaining};
    }
    case 'deliverOrder':return one('protocol','deliver_order');
    case 'registerIssuer':case 'deactivateIssuer':return one('registry',cmd.kind==='registerIssuer'?'register_issuer':'deactivate_issuer',{wallet:cmd.wallet});
    case 'stopIssuance':case 'resumeIssuance':return one('registry',cmd.kind==='stopIssuance'?'stop_issuance':'resume_issuance');
    case 'registerAttestor':case 'revokeAttestor':return one('registry',cmd.kind==='registerAttestor'?'register_attestor':'revoke_attestor',{addr:cmd.attestor});
    case 'registerVerifierKey':case 'revokeVerifierKey':return one('registry',cmd.kind==='registerVerifierKey'?'register_verifier_key':'revoke_verifier_key',{addr:cmd.key});
    case 'rotateAttestor':case 'rotateVerifierKey':{
      const type=cmd.kind==='rotateAttestor'?'attestor':'verifier_key';return {instructions:[await ix('registry',`register_${type}`,{addr:cmd.to}),await ix('registry',`revoke_${type}`,{addr:cmd.from})]};
    }
    case 'setAllowlist':return one('registry','set_allowed',{wallet:cmd.wallet,allowed:cmd.allowed});
    case 'setFeeCollector':return one('registry','set_fee_collector',{new_collector:cmd.feeCollector});
    case 'setFlags':case 'pauseNewRaises':return one('registry','set_flags',{new_raises_paused:cmd.kind==='pauseNewRaises'?cmd.paused:cmd.newRaisesPaused??cfg.new_raises_paused,windows_enabled:cmd.kind==='setFlags'?cmd.windowsEnabled??cfg.windows_enabled:cfg.windows_enabled,tier4_enabled:cmd.kind==='setFlags'?cmd.tier4Enabled??cfg.tier4_enabled:cfg.tier4_enabled});
    case 'setFxPair':return one('registry','set_fx_pair',{pair_id:hex(fxPairId(cmd.feedId,cmd.inverted)),feed_id:cmd.feedId,inverted:cmd.inverted,crosscheck:cmd.crosscheck??SYSTEM,enabled:true});
    case 'snapshotFx':{
      const pair=pda(protocol,'fxpair',bytes(cmd.pairId)),pairConfig=pda(registry,'fx',bytes(cmd.pairId));
      const fx=(await transport.account(pairConfig,'FxPairConfig'))?.value;if(!fx)throw new ChainError('NotFound','FX pair is not registered');
      rows.pair={pair_id:bytes(cmd.pairId)};
      const period=pidAt(BigInt(ctx.now)),feed=hex(fx.feed_id),cross=Number(fx.crosscheck_effective_period)<=period?String(fx.crosscheck):String(fx.prev_crosscheck);
      const price=config.priceUpdateAccounts?.[feed],crossFeed=cross===SYSTEM?null:`0x${new PublicKey(cross).toBuffer().toString('hex')}`,crossPrice=crossFeed?config.priceUpdateAccounts?.[crossFeed]:null;
      if(!price||crossFeed&&!crossPrice)throw new ChainError('ChainSpecific','verified Pyth feed accounts are not configured for this pair');
      const instructions=[await ix('protocol','snapshot_fx',{period},{pair,pair_config:pairConfig,price_update:price,crosscheck_update:crossPrice??null})];
      return {instructions,...(!await transport.account(pair,'FxPair')?{preparations:[{summary:'Initialize FX accumulator',instructions:[await ix('protocol','init_fx_pair',{pair_id:cmd.pairId})]}]}:{})};
    }
    case 'crankStatus':case 'crankPause':return one('protocol','crank_status');
    case 'createCurveConfig':case 'createCurvePool':case 'migrateCurve':case 'curveSwap':case 'stakeUnits':case 'unstakeUnits':case 'tenderUnits':case 'completeCurve':case 'collectCurveProceeds':case 'syncCurveUnits':return ctx.curve.instructions(cmd,signer);
    case 'snapshotRate':case 'flagFxFallback':case 'openTransferWindow':case 'clearTransferWindow':case 'registerSplitRouter':case 'postSplitReceipt':throw new ChainError('NotPermitted',`${cmd.kind} is a simulator convenience; use the Stage 1 canonical command`);
  }
}

type IxBuilder=(module:SolModule,name:string,args?:Row,over?:Record<string,string|null>,remaining?:AccountMeta[])=>Promise<TransactionInstruction>;
async function takebackPreparations(w:Row,orders:SolAccount[],ix:IxBuilder):Promise<NonNullable<SolPlan['preparations']>>{
  if(Number(w.next_bid_index)<Number(w.revealed_bids)||w.tb_settled||b(w.cancelled_units)<=b(w.ask_at_total))return [];
  if(b(w.tb_round)===0n||w.tb_rejected){
    let remaining=b(w.cancelled_units)-b(w.ask_at_total);
    const below=orders.filter((a)=>a.value.side===1&&a.value.revealed&&a.value.valid&&b(a.value.price)<b(w.clearing_price)).sort((a,c)=>b(a.value.price)===b(c.value.price)?Number(c.value.reveal_index)-Number(a.value.reveal_index):b(a.value.price)>b(c.value.price)?-1:1);
    for(const a of below){if(remaining<=b(a.value.quantity))return [{summary:'Propose cancelled-bid ask take-back',instructions:[await ix('protocol','begin_takeback',{price:a.value.price,reveal_index:a.value.reveal_index})]}];remaining-=b(a.value.quantity);}
    throw new ChainError('ChainSpecific','cancelled units exceed available asks');
  }
  const untallied=orders.filter((a)=>a.value.side===1&&a.value.revealed&&a.value.takeback_round!==w.tb_round).slice(0,24);
  if(untallied.length)return [{summary:'Tally cancelled-bid ask take-back',instructions:[await ix('protocol','tally_takeback',{}, {},untallied.map((a)=>meta(a.address,true)))]}];
  return [{summary:'Finalize cancelled-bid ask take-back',instructions:[await ix('protocol','finalize_takeback')]}];
}

async function stableHookAccounts(ctx:SolCommandContext,ix:TransactionInstruction,accounts:Record<string,string|null>,s:Row,cmd:Command,signer:string):Promise<void>{
  if(s.stablecoin_program!==TOKEN_2022)return;
  const mintKey=new PublicKey(String(s.stablecoin)),raw=await ctx.transport.raw(mintKey.toBase58());if(!raw)throw new ChainError('NotFound','stablecoin mint is missing');
  const mint=unpackMint(mintKey,raw,new PublicKey(TOKEN_2022)),hook=getTransferHook(mint);if(!hook||hook.programId.equals(PublicKey.default))return;
  // Extra meta resolution validates account-data-derived PDAs using the canonical SPL client. The onchain transfer
  // helper selects what each transfer needs from this union, so source/destination roles cannot be interchanged.
  const pairs:[string,string,string,bigint][]=[];
  const add=(from:string,to:string,authority:string,amount:bigint)=>{if(accounts[from]&&accounts[to]&&accounts[authority])pairs.push([accounts[from]!,accounts[to]!,accounts[authority]!,amount]);};
  const amount='amount' in cmd?b(cmd.amount??0):'deposit' in cmd?b(cmd.deposit):0n;
  add('bidder_stable','escrow_token','bidder',amount);add('owner_stable','window_stable','owner',amount);add('payer_stable','vault_token','payer',amount);add('issuer_stable','vault_token','issuer',amount);
  for(const dest of ['issuer_stable_ata','fee_collector_ata','holder_stable_ata','owner_stable_ata'])add('vault_token',dest,'vault_auth',amount);
  add('treasury_token','issuer_stable','treasury_auth',amount);add('treasury_token','vault_token','treasury_auth',amount);
  for(const dest of ['treasury_token','fee_collector_ata','bidder_stable_ata'])add('escrow_token',dest,'escrow_auth',amount);
  for(const dest of ['fee_collector_ata','owner_stable_ata'])add('window_stable',dest,'window_escrow_auth',amount);
  for(const dest of ['vault_token','issuer_stable_ata'])add('router_token',dest,'router_auth',amount);
  for(const [source,dest,owner,value] of pairs){
    const transfer=createTransferCheckedInstruction(new PublicKey(source),mintKey,new PublicKey(dest),new PublicKey(owner),value,Number(s.stablecoin_decimals),[],new PublicKey(TOKEN_2022));
    await addExtraAccountMetasForExecute(ctx.transport.connection,transfer,hook.programId,new PublicKey(source),mintKey,new PublicKey(dest),new PublicKey(owner),value,'finalized');
    const probe=createTransferCheckedInstruction(new PublicKey(source),mintKey,new PublicKey(dest),new PublicKey(owner),value+1n,Number(s.stablecoin_decimals),[],new PublicKey(TOKEN_2022));
    await addExtraAccountMetasForExecute(ctx.transport.connection,probe,hook.programId,new PublicKey(source),mintKey,new PublicKey(dest),new PublicKey(owner),value+1n,'finalized');
    if(probe.keys.length!==transfer.keys.length||probe.keys.some((k,i)=>!k.pubkey.equals(transfer.keys[i]!.pubkey)))throw new ChainError('NotPermitted','amount-dependent stablecoin hooks require a precise transfer quote');
    for(const key of transfer.keys.slice(4)){
      if(key.isSigner&&!key.pubkey.equals(new PublicKey(signer)))throw new ChainError('NotPermitted','stablecoin hook requires an additional wallet signer');
      if(!ix.keys.some((k)=>k.pubkey.equals(key.pubkey)))ix.keys.push(key);
    }
  }
  void signer;
}

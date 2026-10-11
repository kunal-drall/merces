import {PublicKey} from '@solana/web3.js';
import {unpackMint} from '@solana/spl-token';
import BN from 'bn.js';
import {DynamicBondingCurveClient,SwapMode,deriveDammV2TokenVaultAddress,deriveEscrow,deriveBaseKeyForLocker,PROTOCOL_FEE_PERCENT,getBaseFeeHandler,getTotalFeeNumerator,TradeDirection} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {projectPoolProgress} from '@merces/meteora/src/state.ts';
import {ChainError,type ChainPort,type Command,type CurveState} from '@merces/domain';
import {pda,programOf,ata,TOKEN_2022,SYSTEM,resolveAccounts,createAta,meta} from './accounts.ts';
import {instruction,type Row} from './codec.ts';
import {SolanaReads,b,n} from './reads.ts';
import type {SolanaTransport} from './transport.ts';
import type {SolanaChainConfig} from './config.ts';
import type {SolPlan} from './commands.ts';

/** Reads finalized DBC accounts; all authority and census accounts follow Stage 1 curve.rs. */
export class SolanaCurve {
  readonly client:DynamicBondingCurveClient;
  constructor(readonly config:SolanaChainConfig,readonly transport:SolanaTransport){this.client=new DynamicBondingCurveClient(transport.connection,'finalized');}
  async pool(sid:string){
    await this.transport.verifyNetwork();const reads=new SolanaReads(this.config,this.transport,(await this.transport.head()).time),s=await reads.s(sid);
    if(!s||n(s.mode)!==1)return null;
    const address=String(s.dbc_pool)===SYSTEM?this.config.curvePools?.[sid]:String(s.dbc_pool);if(!address)return null;
    const key=new PublicKey(address),pool=await this.client.state.getPool(key);if(!pool)throw new ChainError('NotFound','configured Meteora pool is missing');
    const cfg=await this.client.state.getPoolConfig(pool.poolState.config);if(!cfg)throw new ChainError('NotFound','Meteora pool configuration is missing');
    const progress=projectPoolProgress(key,pool,cfg),authority=pda(reads.protocol,'curve_authority',reads.address(sid));
    if(progress.quoteMint!==s.stablecoin||progress.feeClaimer!==authority||progress.leftoverReceiver!==authority||progress.migrationQuoteThreshold!==b(s.min_raise)||progress.swapBaseAmount!==b(s.units_offered)*1000000n)throw new ChainError('InvalidTerms','Meteora pool differs from the series terms or treasury authorities');
    return {reads,s,pool,cfg,progress};
  }
  censusAccounts(series:string,p:NonNullable<Awaited<ReturnType<SolanaCurve['pool']>>>['progress']){
    const authority=pda(programOf(this.config,'protocol'),'curve_authority',series);
    return {base_mint:p.baseMint,dbc_pool:p.pool,dbc_base_vault:p.baseVault,damm_config:p.dammConfig,damm_pool:p.dammV2Pool,damm_base_vault:deriveDammV2TokenVaultAddress(new PublicKey(p.dammV2Pool),new PublicKey(p.baseMint)).toBase58(),locker_escrow_token:ata(deriveEscrow(deriveBaseKeyForLocker(new PublicKey(p.pool))).toBase58(),p.baseMint,TOKEN_2022),leftover_token:ata(authority,p.baseMint,TOKEN_2022)};
  }
  async getCurve(sid:string):Promise<CurveState|null>{
    const data=await this.pool(sid);if(!data)return null;const {reads,s,pool,cfg,progress:p}=data,address=reads.address(sid),l=await reads.row('ledger',address,'Ledger'),accounts=this.censusAccounts(address,p);
    const raw=await this.transport.raw(p.baseMint);if(!raw)throw new ChainError('ChainSpecific','curve mint is missing');const mint=unpackMint(new PublicKey(p.baseMint),raw,new PublicKey(TOKEN_2022));
    const balances=await Promise.all([accounts.dbc_base_vault,accounts.damm_base_vault,accounts.locker_escrow_token,accounts.leftover_token].map((a)=>this.transport.tokenBalance(a,p.baseMint))),held=balances.reduce((s,v)=>s+v,0n),outstanding=mint.supply-held;
    if(outstanding<0n||outstanding<b(l.staked_total))throw new ChainError('ChainSpecific','curve unit census is inconsistent');
    const h=await reads.history(address),collected=(field:string)=>h.filter((e)=>e.name==='CurveProceedsCollected').reduce((a,e)=>a+b(e.args[field]),0n);
    const head=await this.transport.head(),point=new BN(String(cfg.activationType===0?head.slot:head.time));
    const base=getBaseFeeHandler(cfg.poolFees.baseFee.cliffFeeNumerator,cfg.poolFees.baseFee.firstFactor,cfg.poolFees.baseFee.secondFactor,cfg.poolFees.baseFee.thirdFactor,cfg.poolFees.baseFee.baseFeeMode).getBaseFeeNumeratorFromIncludedFeeAmount(point,pool.poolState.activationPoint,TradeDirection.QuoteToBase,new BN(1000000));
    const fee=getTotalFeeNumerator(base,cfg.poolFees.dynamicFee,pool.poolState.volatilityTracker),protocol=PROTOCOL_FEE_PERCENT*100,creator=(10000-protocol)*cfg.creatorTradingFeePercentage/100;
    return {seriesId:sid,venue:'meteora-dbc',dbcConfig:p.config,dbcPool:p.pool,baseMint:p.baseMint,quoteStablecoin:'USDC',migrationQuoteThreshold:String(p.migrationQuoteThreshold),quoteReserve:String(p.quoteReserve),progressBps:p.progressBps,finishCurveTimestamp:Number(p.finishCurveTimestamp)||null,poolComplete:p.curveComplete||p.isMigrated,settled:n(s.raise_state)===4,issuePrice:String(s.clearing_price),unitsSold:String(s.units_sold),baseSold:String(p.baseSold),baseSupply:String(mint.supply),spotPrice:String(p.pricePerUnit.current),tradingFeeBps:Number(BigInt(fee.toString())*10000n/1000000000n),tradingFeeSplitBps:{protocol,partner:10000-protocol-creator,creator},migrationFeePercentage:cfg.migrationFeePercentage,tradingFeeUncollected:String(p.unclaimedFees.partnerQuote),collected:{migrationFee:String(collected('migration_fee')),surplus:String(collected('surplus')),tradingFee:String(collected('trading_fee')),proceeds:String(collected('proceeds'))},census:{supply:String(mint.supply),protocolHeld:String(held),unitsOutstanding:String(outstanding),redemptionUnits:String(outstanding+balances[1]!),stakedTotal:String(l.staked_total??0),synced:b(l.units_synced_at)?{unitsOutstanding:String(l.units_outstanding),at:n(l.units_synced_at)}:null,changedSinceSync:!b(l.units_synced_at)||outstanding!==b(l.units_outstanding)}};
  }
  async quoteCurveSwap(sid:string,side:'buy'|'sell',amount:string):ReturnType<ChainPort['quoteCurveSwap']>{
    if(!/^\d+$/.test(amount)||BigInt(amount)<=0n)throw new ChainError('InvalidTerms','swap amount must be positive');
    const data=await this.pool(sid);if(!data)throw new ChainError('NotFound','curve pool is not configured');const {pool,cfg,progress}=data;
    if(progress.curveComplete||progress.isMigrated)throw new ChainError('WrongPhase','curve is complete');
    const head=await this.transport.head();
    const q=this.client.pool.swapQuote2({virtualPool:pool,config:cfg,swapBaseForQuote:side==='sell',swapMode:SwapMode.PartialFill,amountIn:new BN(amount),hasReferral:false,eligibleForFirstSwapWithMinFee:false,currentPoint:new BN(String(cfg.activationType===0?head.slot:head.time)),slippageBps:0});
    return {seriesId:sid,side,amountIn:amount,amountUsed:q.includedFeeInputAmount.toString(),amountOut:q.outputAmount.toString(),fee:q.tradingFee.add(q.protocolFee).add(q.referralFee).toString(),fillsCurve:side==='buy'&&q.nextSqrtPrice.gte(cfg.migrationSqrtPrice)};
  }
  async instructions(cmd:Command,signer:string):Promise<SolPlan>{
    if(!('seriesId' in cmd))throw new ChainError('InvalidTerms','curve command requires a series');
    const data=await this.pool(cmd.seriesId);if(!data)throw new ChainError('NotFound','create a Stage 1 compatible Meteora pool and configure its address before activating the curve');
    const {reads,s,progress:p}=data,series=reads.address(cmd.seriesId),protocol=reads.protocol,registry=reads.registry;
    const cfg=(await this.transport.account(pda(registry,'config'),'ProtocolConfig'))!.value,l=await reads.row('ledger',series,'Ledger');
    const known:Record<string,string|null>={series,issuer:String(s.issuer),owner:signer,payer:signer,config:pda(registry,'config'),dbc_config:p.config,dbc_quote_vault:p.quoteVault,stablecoin_mint:String(s.stablecoin),stablecoin_program:String(s.stablecoin_program),issuer_stable:ata(String(s.issuer),String(s.stablecoin),String(s.stablecoin_program)),owner_stable_ata:ata(signer,String(s.stablecoin),String(s.stablecoin_program)),owner_base_ata:ata(signer,p.baseMint,TOKEN_2022),stake_vault:ata(pda(protocol,'curve_stake',series),p.baseMint,TOKEN_2022),fee_collector_token:ata(String(cfg.fee_collector),String(s.stablecoin),String(s.stablecoin_program)),...this.censusAccounts(series,p)};
    const ix=(name:string,args:Row={})=>instruction('protocol',protocol,name,args,resolveAccounts(this.config,'protocol',name,args,known,{series:s,config:cfg,ledger:l}));
    switch(cmd.kind){
      case 'openRaise':return {instructions:[ix('activate_curve')],...(!await this.transport.account(pda(protocol,'ledger',series),'Ledger')?{preparations:[{summary:'Prepare curve accounts',instructions:[ix('prepare_curve')]}]}:{})};
      case 'curveSwap':{await this.quoteCurveSwap(cmd.seriesId,cmd.side,cmd.amountIn);const tx=await this.client.pool.swap2({owner:new PublicKey(signer),pool:new PublicKey(p.pool),swapBaseForQuote:cmd.side==='sell',swapMode:SwapMode.PartialFill,amountIn:new BN(cmd.amountIn),minimumAmountOut:new BN(cmd.minimumAmountOut),referralTokenAccount:null});return {instructions:tx.instructions};}
      case 'completeCurve':return {instructions:[ix('complete_curve')]};
      case 'collectCurveProceeds':return {instructions:[createAta(signer,String(cfg.fee_collector),String(s.stablecoin),String(s.stablecoin_program)),ix('collect_curve_proceeds')]};
      case 'syncCurveUnits':return {instructions:[ix('sync_curve_units')]};
      case 'stakeUnits':case 'unstakeUnits':return {instructions:[createAta(signer,signer,p.baseMint,TOKEN_2022),ix(cmd.kind==='stakeUnits'?'stake_units':'unstake_units',{units:cmd.units})]};
      case 'tenderUnits':return {instructions:[createAta(signer,signer,p.baseMint,TOKEN_2022),createAta(signer,signer,String(s.stablecoin),String(s.stablecoin_program)),ix('tender_units',{from_stake:cmd.fromStake,from_wallet:cmd.fromWallet})]};
      case 'redeem':{const call=ix('redeem');call.keys.push(...Object.values(this.censusAccounts(series,p)).map((a)=>meta(a)));return {instructions:[call]};}
      default:throw new ChainError('NotPermitted','unsupported curve command');
    }
  }
}

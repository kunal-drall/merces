import {describe,expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {defaultTerms,SimulatorChain} from '@merces/simulator';
import {ZERO_INCOME_COMMITMENT,reportPublicInputs,type Command} from '@merces/domain';
import {idlOf,decodeInstruction,type IdlType,type Row} from '../src/codec.ts';
import {planSolCommand,type SolCommandContext} from '../src/commands.ts';
import {pda,programOf,SYSTEM,TOKEN,TOKEN_2022,ata} from '../src/accounts.ts';
import type {SolanaChainConfig} from '../src/config.ts';
const key=(x:number)=>new PublicKey(Buffer.alloc(32,x)).toBase58();
const wallet=key(11),series=key(12),mint=key(13),unit=key(14),hash='0x'+'11'.repeat(32),addr='0x'+'12'.repeat(20),sid=`solana:${series}`;
export const config:SolanaChainConfig={chain:'solana',cluster:'localnet',rpcUrl:'http://localhost:8899',programs:Object.fromEntries(['registry','protocol','hook'].map((m)=>[`merces_${m}`,idlOf(m as 'registry').address])),idlDir:null,generatedDir:null,stablecoins:{USDC:mint},startSlot:0,keeperPublicKey:null,allowlistManagerPublicKey:null};
function zero(module:'registry'|'protocol',t:IdlType):unknown{
 const idl=idlOf(module);if(typeof t==='string')return t==='pubkey'?SYSTEM:t==='bool'?false:t==='string'?'':t==='bytes'?Buffer.alloc(0):0;
 if('option'in t)return null;if('vec'in t)return [];if('array'in t)return t.array[0]==='u8'?Buffer.alloc(t.array[1]):Array.from({length:t.array[1]},()=>zero(module,t.array[0]));
 const d=idl.types.find((d)=>d.name===t.defined.name)!;return Object.fromEntries(d.type.fields!.map((f)=>[f.name,zero(module,f.type)]));
}
function context(){
 const terms=defaultTerms(SimulatorChain.createSync({personality:'solana'})).terms;
 const row=(m:'registry'|'protocol',type:string,over:Row={})=>({...zero(m,{defined:{name:type}}) as Row,...over});
 const rows:Record<string,Row>={ProtocolConfig:row('registry','ProtocolConfig',{fee_collector:key(15),series_count:3,defaults:{auction_fee_bps:terms.auctionFeeBps,payout_fee_bps:terms.payoutFeeBps,window_fee_bps:terms.windowFeeBps,non_reveal_charge_bps:terms.nonRevealChargeBps}}),Series:row('registry','Series',{issuer:wallet,stablecoin:mint,stablecoin_program:TOKEN,stablecoin_decimals:6,unit_mint:unit,base_mint:SYSTEM,terms_commitment:Buffer.from(hash.slice(2),'hex'),mode:0,mint_finalized:true}),Ledger:row('protocol','Ledger',{has_active_window:true,active_window_v:8104,has_open_due_period:true,open_due_period_v:8104,units_outstanding:500}),Auction:row('protocol','Auction',{tally_round:1}),Window:row('protocol','Window',{period:8104,tally_round:1}),Holder:row('protocol','Holder'),Router:row('protocol','Router')};
 const ctx={config,now:1780000000,transport:{account:async(_a:string,type:string)=>rows[type]?{value:rows[type]}:null,scan:async(_m:string,type:string)=>type==='Bid'?[{address:key(16),value:{series,revealed:true,tallied_round:0,reveal_index:0}}]:type==='Order'?[{address:key(17),value:{series,period:8104,revealed:true,tallied_round:0}}]:[]},reads:{getPeriod:async()=>({paymentDue:'9'})},curve:{instructions:async()=>{throw new Error('unexpected curve');}}} as unknown as SolCommandContext;
 return {ctx,rows,terms};
}
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
describe('Solana canonical command encoding',()=>{
 it.each(cases.map((c,i)=>[`${i} ${c.kind}`,c] as const))('%s resolves every required pinned IDL account',async(_name,cmd)=>{
  const {ctx}=context(),plan=await planSolCommand(ctx,cmd,wallet);expect(plan.instructions.length).toBeGreaterThan(0);
  for(const ix of plan.instructions){const m=ix.programId.toBase58()===programOf(config,'registry')?'registry':ix.programId.toBase58()===programOf(config,'protocol')?'protocol':null;if(!m)continue;
   const decoded=decodeInstruction(m,ix.data)!;expect(decoded).not.toBeNull();expect(ix.keys.length).toBeGreaterThanOrEqual(idlOf(m).instructions.find((i)=>i.name===decoded.name)!.accounts.length);
  }
 });
 it('creates a series and binds its contract hash atomically',async()=>{const {ctx,terms}=context();const p=await planSolCommand(ctx,{kind:'createSeries',terms:{...terms,stablecoinMint:mint}},wallet);expect(p.instructions.map((i)=>decodeInstruction('registry',i.data)!.name)).toEqual(['create_series','set_contract_hash']);});
 it('uses the issuer registry PDA for issuance changes',async()=>{const {ctx}=context(),p=await planSolCommand(ctx,{kind:'stopIssuance'},wallet);const spec=idlOf('registry').instructions.find((i)=>i.name==='stop_issuance')!;expect(p.instructions[0]!.keys[spec.accounts.findIndex((a)=>a.name==='issuer')]!.pubkey.toBase58()).toBe(pda(programOf(config,'registry'),'issuer',wallet));});
});

it.each([false,true])('encodes report proof using the Stage 1 census (tail=%s)',async(tail)=>{
 const {ctx,rows}=context();rows.Ledger!.status=tail?5:0;rows.Ledger!.units_outstanding=tail?0:500;rows.Ledger!.units_at_redemption=500;
 const cmd:Extract<Command,{kind:'submitReport'}>={kind:'submitReport',seriesId:sid,periodId:'2026Q1',tier:1,paymentStable:'0',priorIncomeCommitment:ZERO_INCOME_COMMITMENT,incomeCommitment:ZERO_INCOME_COMMITMENT,fxAvgWad:'1000000000000000000',fxFallback:null,attestation:null,liquidityEvent:false,proof:{system:'groth16-bn254',proof:{pi_a:['1','2','1'],pi_b:[['3','4'],['5','6'],['1','0']],pi_c:['7','8','1'],protocol:'groth16',curve:'bn128'},publicInputs:[]}};
 cmd.proof.publicInputs=reportPublicInputs({...cmd,termsCommitment:hash,unitsOutstanding:'500'});
 const plan=await planSolCommand(ctx,cmd,wallet),decoded=decodeInstruction('protocol',plan.instructions[0]!.data)!;
 expect((decoded.args.args as {proof:Buffer}).proof.length).toBe(256);
 await expect(planSolCommand(ctx,{...cmd,proof:{...cmd.proof,publicInputs:Array(6).fill('0')}},wallet)).rejects.toThrow('proof public inputs differ');
});

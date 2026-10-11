import {PublicKey} from '@solana/web3.js';
import {defaultTerms,SimulatorChain} from '@merces/simulator';
import type {Command} from '@merces/domain';
import {idlOf,decodeInstruction,type IdlType,type Row} from '../src/codec.ts';
import {planSolCommand,type SolCommandContext} from '../src/commands.ts';
import {pda,programOf,SYSTEM,TOKEN,TOKEN_2022,ata} from '../src/accounts.ts';
import type {SolanaChainConfig} from '../src/config.ts';
export const key=(x:number)=>new PublicKey(Buffer.alloc(32,x)).toBase58();
const wallet=key(11),series=key(12),mint=key(13),unit=key(14),hash='0x'+'11'.repeat(32),addr='0x'+'12'.repeat(20),sid=`solana:${series}`;
export const config:SolanaChainConfig={chain:'solana',cluster:'localnet',rpcUrl:'http://localhost:8899',programs:Object.fromEntries(['registry','protocol','hook'].map((m)=>[`merces_${m}`,idlOf(m as 'registry').address])),idlDir:null,generatedDir:null,stablecoins:{USDC:mint},startSlot:0,keeperPublicKey:null,allowlistManagerPublicKey:null};
function zero(module:'registry'|'protocol',t:IdlType):unknown{
 const idl=idlOf(module);if(typeof t==='string')return t==='pubkey'?SYSTEM:t==='bool'?false:t==='string'?'':t==='bytes'?Buffer.alloc(0):0;
 if('option'in t)return null;if('vec'in t)return [];if('array'in t)return t.array[0]==='u8'?Buffer.alloc(t.array[1]):Array.from({length:t.array[1]},()=>zero(module,t.array[0]));
 const d=idl.types.find((d)=>d.name===t.defined.name)!;return Object.fromEntries(d.type.fields!.map((f)=>[f.name,zero(module,f.type)]));
}
export function context(){
 const terms=defaultTerms(SimulatorChain.createSync({personality:'solana'})).terms;
 const row=(m:'registry'|'protocol',type:string,over:Row={})=>({...zero(m,{defined:{name:type}}) as Row,...over});
 const rows:Record<string,Row>={ProtocolConfig:row('registry','ProtocolConfig',{fee_collector:key(15),series_count:3,defaults:{auction_fee_bps:terms.auctionFeeBps,payout_fee_bps:terms.payoutFeeBps,window_fee_bps:terms.windowFeeBps,non_reveal_charge_bps:terms.nonRevealChargeBps}}),Series:row('registry','Series',{issuer:wallet,stablecoin:mint,stablecoin_program:TOKEN,stablecoin_decimals:6,unit_mint:unit,base_mint:SYSTEM,terms_commitment:Buffer.from(hash.slice(2),'hex'),mode:0,mint_finalized:true}),Ledger:row('protocol','Ledger',{has_active_window:true,active_window_v:8104,has_open_due_period:true,open_due_period_v:8104,units_outstanding:500}),Auction:row('protocol','Auction',{tally_round:1}),Window:row('protocol','Window',{period:8104,tally_round:1}),Holder:row('protocol','Holder'),Router:row('protocol','Router')};
 const ctx={config,now:1780000000,transport:{account:async(_a:string,type:string)=>rows[type]?{value:rows[type]}:null,scan:async(_m:string,type:string)=>type==='Bid'?[{address:key(16),value:{series,revealed:true,tallied_round:0,reveal_index:0}}]:type==='Order'?[{address:key(17),value:{series,period:8104,revealed:true,tallied_round:0}}]:[]},reads:{getPeriod:async()=>({paymentDue:'9'})},curve:{instructions:async()=>{throw new Error('unexpected curve');}}} as unknown as SolCommandContext;
 return {ctx,rows,terms};
}

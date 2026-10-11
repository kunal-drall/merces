import {describe,expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {buildMercesCurveConfig} from '@merces/meteora/src/config.ts';
import {scenario,poolConfigObject,encodeAccount,tokenAccount} from '../../../stage1/solana/meteora/test/helpers/stub.ts';
import {SolanaCurve} from '../src/curve.ts';
import {SolanaTransport} from '../src/transport.ts';
import {pda,programOf,TOKEN_2022} from '../src/accounts.ts';
import {decodeInstruction} from '../src/codec.ts';
import {context,key} from './fixtures.ts';
import type {Command} from '@merces/domain';
const sid=`solana:${key(12)}`,wallet=key(11);
async function fixture(){
 const {ctx,rows}=context(),cfg=buildMercesCurveConfig({trailingAnnualIncome:40000000000n,targetRaise:100000000000n,unitsOnCurve:10000n,quoteMint:key(13)}),world=await scenario(cfg,{withPool:true});
 const authority=new PublicKey(pda(programOf(ctx.config,'protocol'),'curve_authority',key(12)));
 const addresses={...world.addresses,feeClaimer:authority,leftoverReceiver:authority};
 world.accounts.set(addresses.config,await encodeAccount(world.connection,'poolConfig',poolConfigObject(cfg,addresses)));
 Object.assign(rows.Series!,{mode:1,units_offered:10000,min_raise:100000000000n,dbc_pool:addresses.pool.toBase58(),base_mint:addresses.baseMint.toBase58()});
 const mint=world.accounts.map.get(addresses.baseMint.toBase58())!;mint.data.writeBigUInt64LE(cfg.derived.initialBaseSupply,36);
 const transport=new SolanaTransport(ctx.config,world.connection,async()=>{});
 transport.account=async(address,type)=>rows[type??'']?{address,module:type==='Series'||type==='ProtocolConfig'?'registry':'protocol',type:type!,value:rows[type!]!}:null;
 transport.history=async()=>[];
 const curve=new SolanaCurve(ctx.config,transport),pool=(await curve.pool(sid))!;
 world.accounts.set(new PublicKey(pool.progress.baseVault),tokenAccount(addresses.baseMint,authority,cfg.derived.initialBaseSupply-3000000n,new PublicKey(TOKEN_2022)));
 return {curve,rows,transport,world,cfg};
}
describe('live Meteora account and instruction integration',()=>{
 it('reads real SDK account bytes, validates treasury authorities and quotes from the pinned curve math',async()=>{
  const {curve,rows}=await fixture();
  const state=await curve.getCurve(sid);expect(state).toMatchObject({settled:false,census:{unitsOutstanding:'3000000'}});
  const quote=await curve.quoteCurveSwap(sid,'buy','1000000');expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);expect(BigInt(quote.amountUsed)).toBeLessThanOrEqual(1000000n);
  rows.Series!.min_raise=1n;await expect(curve.getCurve(sid)).rejects.toThrow('differs from the series');
 });
 it.each(['openRaise','completeCurve','collectCurveProceeds','syncCurveUnits','stakeUnits','unstakeUnits','tenderUnits','redeem'] as const)('encodes %s with all Stage 1 required accounts',async(kind)=>{
  const {curve}=await fixture(),command={kind,seriesId:sid,units:'1',fromStake:'1',fromWallet:'0'} as Command;
  const plan=await curve.instructions(command,wallet),protocol=programOf(curve.config,'protocol');
  const main=plan.instructions.find((i)=>i.programId.toBase58()===protocol)!;expect(main).toBeDefined();
  const name=decodeInstruction('protocol',main.data)!.name;
  expect(name).toBe(({openRaise:'activate_curve',completeCurve:'complete_curve',collectCurveProceeds:'collect_curve_proceeds',syncCurveUnits:'sync_curve_units',stakeUnits:'stake_units',unstakeUnits:'unstake_units',tenderUnits:'tender_units',redeem:'redeem'} as const)[kind]);
  expect(main.keys.every((k)=>k.pubkey instanceof PublicKey)).toBe(true);
  expect(main.keys.filter((k)=>k.isSigner).every((k)=>k.pubkey.toBase58()===wallet)).toBe(true);
 });
});

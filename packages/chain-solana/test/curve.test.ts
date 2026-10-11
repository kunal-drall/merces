import {describe,expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {jsonify} from '@merces/meteora/src/types.ts';
import {buildMercesCurveConfig} from '@merces/meteora/src/config.ts';
import {scenario,poolConfigObject,encodeAccount,tokenAccount,virtualPoolObject} from '../../../stage1/solana/meteora/test/helpers/stub.ts';
import {SolanaCurve} from '../src/curve.ts';
import {SolanaTransport} from '../src/transport.ts';
import {pda,programOf,TOKEN_2022} from '../src/accounts.ts';
import {decodeInstruction} from '../src/codec.ts';
import {context,key} from './fixtures.ts';
import type {Command} from '@merces/domain';
const sid=`solana:${key(12)}`,wallet=key(11);
async function fixture(){
 const {ctx,rows}=context(),cfg=buildMercesCurveConfig({trailingAnnualIncome:40000000000n,targetRaise:100000000000n,unitsOnCurve:10000n,quoteMint:key(13),migrationFee:{feePercentage:99,creatorFeePercentage:0}}),world=await scenario(cfg,{withPool:true});
 const authority=new PublicKey(pda(programOf(ctx.config,'protocol'),'curve_authority',key(12)));
 const addresses={...world.addresses,creator:new PublicKey(wallet),feeClaimer:authority,leftoverReceiver:authority};
 world.accounts.set(addresses.pool,await encodeAccount(world.connection,'virtualPool',virtualPoolObject(cfg,addresses)));
 world.accounts.set(addresses.config,await encodeAccount(world.connection,'poolConfig',poolConfigObject(cfg,addresses)));
 Object.assign(rows.Series!,{mode:1,reserve_price:cfg.anchoring.startPricePerUnit,units_offered:10000,min_raise:100000000000n,dbc_pool:addresses.pool.toBase58(),base_mint:addresses.baseMint.toBase58()});
 const mint=world.accounts.map.get(addresses.baseMint.toBase58())!;mint.data.writeBigUInt64LE(cfg.derived.initialBaseSupply,36);
 const transport=new SolanaTransport(ctx.config,world.connection,async()=>{});
 transport.account=async(address,type)=>rows[type??'']?{address,module:type==='Series'||type==='ProtocolConfig'?'registry':'protocol',type:type!,value:rows[type!]!}:null;
 transport.history=async()=>[];
 const curve=new SolanaCurve(ctx.config,transport),pool=(await curve.pool(sid))!;
 world.accounts.set(new PublicKey(pool.progress.baseVault),tokenAccount(addresses.baseMint,authority,cfg.derived.initialBaseSupply-3000000n,new PublicKey(TOKEN_2022)));
 return {curve,rows,transport,world,cfg,addresses};
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
 it('builds issuer-owned config and pool creation with the treasury route and only fresh account signers',async()=>{
  const {curve,cfg,addresses}=await fixture();
  const config=key(41),baseMint=key(42),parameters=jsonify(cfg.configParameters);
  const plan=await curve.instructions({kind:'createCurveConfig',seriesId:sid,config,parameters},wallet);
  const create=plan.instructions.at(-1)!;
  expect(create.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58()).sort()).toEqual([wallet,config].sort());
  const pool=await curve.instructions({kind:'createCurvePool',seriesId:sid,config:addresses.config.toBase58(),baseMint},wallet);
  expect(pool.instructions.flatMap(i=>i.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58()))).toContain(baseMint);
  await expect(curve.instructions({kind:'createCurveConfig',seriesId:sid,config,parameters:{...parameters,migrationFee:{feePercentage:99,creatorFeePercentage:100}}},wallet)).rejects.toThrow('treasury route');
  await expect(curve.instructions({kind:'createCurveConfig',seriesId:sid,config,parameters},key(43))).rejects.toThrow('only the issuer');
 });
 it('rejects an issuer migration-fee share before a wallet signs activation',async()=>{
  const {curve,cfg,addresses,world}=await fixture();
  const invalid=poolConfigObject(cfg,addresses);invalid.creatorMigrationFeePercentage=100;
  world.accounts.set(addresses.config,await encodeAccount(world.connection,'poolConfig',invalid));
  await expect(curve.instructions({kind:'openRaise',seriesId:sid},wallet)).rejects.toThrow('bypass the series treasury');
 });
 it('builds DAMM v2 migration only after completion with explicitly reviewed position accounts',async()=>{
  const {curve,cfg,world,addresses}=await fixture();
  const command={kind:'migrateCurve' as const,seriesId:sid,firstPositionMint:key(44),secondPositionMint:key(45)};
  await expect(curve.instructions(command,wallet)).rejects.toThrow('must be complete');
  world.accounts.set(addresses.pool,await encodeAccount(world.connection,'virtualPool',virtualPoolObject(cfg,addresses,{quoteReserve:cfg.anchoring.migrationQuoteThreshold,finishCurveTimestamp:1700000000n})));
  const plan=await curve.instructions(command,wallet),ix=plan.instructions[0]!;
  expect(ix.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58()).sort()).toEqual([wallet,command.firstPositionMint,command.secondPositionMint].sort());
  expect(ix.keys.map(k=>k.pubkey.toBase58())).toContain((await curve.pool(sid))!.progress.dammV2Pool);
  expect(plan.preparations).toBeUndefined();
 });

});

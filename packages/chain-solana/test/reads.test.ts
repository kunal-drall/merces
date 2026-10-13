import {describe,expect,it} from 'vitest';
import {SolanaReads} from '../src/reads.ts';
import {context,key} from './fixtures.ts';
import type {SolanaTransport} from '../src/transport.ts';
const sid=`solana:${key(12)}`;
function fixture(){const {ctx,rows}=context();const transport={...ctx.transport,history:async()=>[],scan:async()=>[],tokenBalance:async()=>0n} as unknown as SolanaTransport;return {reads:new SolanaReads(ctx.config,transport,ctx.now),rows};}
describe('Solana finalized account projections',()=>{
 it('keeps unfunded zero-value tranches pending before settlement',async()=>{
  const {reads,rows}=fixture();rows.Series!.release_count=1;rows.Series!.release_schedule=[{at_offset_seconds:0,bps:10000}];
  const treasury=await reads.getTreasury(sid);expect(treasury?.tranches).toHaveLength(1);expect(treasury?.tranches[0]).toMatchObject({amount:'0',drawableAt:null,drawn:false});
 });
 it('reads prepared draft accounts and positions with the pinned IDL field names',async()=>{
  const {reads}=fixture();expect(await reads.getSeries(sid)).toMatchObject({phase:'Draft',unitScale:'1'});expect(await reads.getAuction(sid)).toMatchObject({phase:'Draft',bidCount:0});expect(await reads.getTreasury(sid)).toMatchObject({balance:'0'});expect(await reads.getVault(sid)).toMatchObject({dust:'0'});expect(await reads.getPosition(sid,key(11))).toMatchObject({walletUnits:'0',tailClaimable:'0'});expect(await reads.getTransferWindow(sid,8104)).toMatchObject({windowId:8104});
 });
 it('counts redemption principal per claim with curve rounding, excluding pending payouts',async()=>{
  const {reads,rows}=fixture();rows.Series!.mode=1;rows.Ledger!.redemption_ts=1767225600;rows.Ledger!.redemption_price=3;rows.Ledger!.units_at_redemption=1000000;
  const record=(units:bigint)=>({name:'RedemptionClaimed',args:{units,amount:9n}});
  const r=reads.redemption(sid,rows.Series!,rows.Ledger!,[record(333333n),record(333333n)] as never);expect(r?.claimed).toBe('0');expect(r?.deposit).toBe('3');
 });
});

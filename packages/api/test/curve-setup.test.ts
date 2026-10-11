import {describe,expect,it,vi} from 'vitest';
import {MeteoraService} from '../../services/src/meteora/service.ts';
import {AuctionService} from '../../services/src/auction/service.ts';
import type {Session} from '../src/index.ts';
import type {ServiceContext} from '../../services/src/context.ts';
import {CURVE_BUYER_NOTICE,CURVE_NO_CAP} from '@merces/domain';

function fixture(){
  const series={seriesId:'solana:series',issuer:'issuer',phase:'Draft',terms:{raiseStyle:'curve',contractHash:'0x11',commitDurationSeconds:0,revealDurationSeconds:0}};
  const chain={chain:'solana',family:'solana',mode:'live',getSeries:vi.fn(async()=>series),getCurve:vi.fn(async()=>null),isAllowlisted:vi.fn(async()=>true),info:vi.fn(async()=>({newRaisesPaused:false})),build:vi.fn(async(command,signer)=>({command,signer}))};
  const ctx={chainFor:()=>chain} as unknown as ServiceContext;
  const session={accountId:'account',roles:['issuer'],wallets:[{chain:'solana',address:'issuer'}]} as Session;
  return {series,chain,ctx,session,service:new MeteoraService(ctx,{} as never,{} as never)};
}

describe('native curve launch API boundaries',()=>{
  it('opens a draft native curve through the existing raise builder',async()=>{
    const {ctx,chain}=fixture();
    const result=await new AuctionService(ctx).buildOpenRaise('solana:series');
    expect(result.commitDurationSeconds).toBe(0);
    expect(chain.build).toHaveBeenCalledWith({kind:'openRaise',seriesId:'solana:series'},'issuer');
  });
  it('builds only for the linked issuer and the route series',async()=>{
    const {service,session,chain}=fixture();
    const command={kind:'createCurvePool' as const,seriesId:'solana:series',config:'config',baseMint:'mint'};
    await expect(service.buildSetup('solana:series',session,command)).resolves.toMatchObject({walletCap:null,noCap:true,noCapStatement:CURVE_NO_CAP,notice:CURVE_BUYER_NOTICE});
    await expect(service.buildSetup('solana:other',session,command)).rejects.toMatchObject({status:403});
    await expect(service.buildSetup('solana:series',{...session,wallets:[]},command)).rejects.toMatchObject({status:403});
    expect(chain.build).toHaveBeenCalledTimes(1);
  });
  it('requires a linked migration payer and preserves the no-cap notice',async()=>{
    const {service,session,chain}=fixture();
    const command={kind:'migrateCurve' as const,seriesId:'solana:series',firstPositionMint:'mint1',secondPositionMint:'mint2'};
    await expect(service.buildMigration('solana:series',session,'issuer',command)).resolves.toMatchObject({walletCap:null,noCap:true,noCapStatement:CURVE_NO_CAP,notice:CURVE_BUYER_NOTICE});
    await expect(service.buildMigration('solana:series',session,'foreign',command)).rejects.toMatchObject({status:403});
    expect(chain.build).toHaveBeenCalledTimes(1);
  });
  it('keeps activation unavailable when raises are paused or the issuer is unapproved',async()=>{
    const {service,session,chain}=fixture(),command={kind:'openRaise' as const,seriesId:'solana:series',curvePool:'pool'};
    chain.info.mockResolvedValue({newRaisesPaused:true});
    await expect(service.buildSetup('solana:series',session,command)).rejects.toMatchObject({status:409});
    chain.info.mockResolvedValue({newRaisesPaused:false});chain.isAllowlisted.mockResolvedValue(false);
    await expect(service.buildSetup('solana:series',session,command)).rejects.toMatchObject({status:403});
    expect(chain.build).not.toHaveBeenCalled();
  });
});

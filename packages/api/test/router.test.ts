import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {dbTestsEnabled} from '@merces/db';
import {TermsService} from '@merces/services';
import {routerJob} from '@merces/keepers';
import {periodOf} from '@merces/math';
import {makeRig} from './helpers.ts';

const USDC=(n:number)=>BigInt(n)*1_000_000n;
const tierFlags={tier1:true,tier2:false,tier3:false,tier4:false};
describe.skipIf(!dbTestsEnabled())('income router API and keeper',()=>{
  let rig:Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async()=>{rig=await makeRig();});
  afterAll(async()=>{await rig.close();});
  it('requires explicit consent before publishing tier-1 terms',async()=>{
    const service=new TermsService(rig.ctx);
    const pub={stablecoin:'USDC' as const,unitsOffered:'1000',reservePrice:'8000000',minimumRaise:'4000000000',capMultiple:'2.5',lockupSeconds:0,releaseSchedule:[{afterSeconds:0,bps:10_000}],hurdle:'0.05',payoutMultipleK:2,tierFlags,reportingCurrency:'USD',raiseStyle:'sealed' as const,country:'US'};
    const priv={threshold:'65000000000',shareRate:'0.1',indexingRule:'none' as const};
    expect((await service.validate('solana',pub,priv,2026)).issues).toContainEqual(expect.objectContaining({field:'routerPublicConsent',code:'consent-required'}));
    expect((await service.validate('solana',{...pub,routerPublicConsent:true},priv,2026)).issues).toEqual([]);
  });
  it.each(['sol','mon'] as const)('%s builds wallet-owned transactions, keeps raw income out of projections, and closes quarters idempotently',async(key)=>{
    const h=rig[key],chain=h.sim.chain;
    const {seriesId}=await h.runRaise({terms:{tierFlags}});
    await rig.sync();
    const issuer=rig.token({accountId:`router-issuer-${chain}`,wallets:[{chain,address:h.issuer.address}],roles:['issuer']});
    const holder=rig.token({accountId:`router-holder-${chain}`,wallets:[{chain,address:h.backers[0]!.address}],roles:['backer']});
    const other=rig.token({accountId:`router-other-${chain}`,wallets:[{chain,address:h.backers[0]!.address}],roles:['issuer']});
    expect((await rig.get(`/series/${seriesId}/router`,holder)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/router`,other)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/router/build-route`,{wallet:h.issuer.address,amount:'10'},holder)).statusCode).toBe(403);
    const built=await rig.post(`/series/${seriesId}/router/build-route`,{wallet:h.issuer.address,amount:USDC(70_000).toString()},issuer);
    expect(built.statusCode,built.body).toBe(200);
    await h.sim.send(await h.issuer.sign(built.json().tx));
    const state=await rig.get(`/series/${seriesId}/router`,issuer);
    expect(state.statusCode,state.body).toBe(200);
    expect(state.json().router.ytdReceived).toBe(USDC(70_000).toString());
    await rig.sync();
    const events=await rig.t.pool.query("select payload from events where series_id=$1 and type like 'Router%'",[seriesId]);
    expect(events.rows.length).toBeGreaterThan(0);
    for(const e of events.rows)expect(e.payload).toEqual({seriesId});
    const q=periodOf(await h.sim.now());
    await h.sim.setTime(q.end+1);
    const result=await routerJob.run(rig.ctx);
    expect(result.errors).toEqual([]);
    expect((await h.sim.getRouter(seriesId))!.checkpoints).toContainEqual({periodId:q.id,ytdAtEnd:USDC(70_000).toString()});
    expect((await routerJob.run(rig.ctx)).actions).toBe(0);
    for(const stopped of [true,false]) {
      const b=await rig.post('/issuers/build-issuance',{chain,wallet:h.issuer.address,stopped},issuer);
      expect(b.statusCode,b.body).toBe(200);
      await h.sim.send(await h.issuer.sign(b.json().tx));
      await rig.sync();
      expect((await h.sim.getIssuer(h.issuer.address))!.issuanceStopped).toBe(stopped);
      expect((await rig.t.pool.query('select issuance_stopped from issuers where chain=$1 and issuer=$2',[chain,h.issuer.address])).rows[0].issuance_stopped).toBe(stopped);
    }
  });
});

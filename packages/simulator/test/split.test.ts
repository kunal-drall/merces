import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error } from './helpers.ts';

const tiers = { tier1: true, tier2: false, tier3: false, tier4: false };
// SPEC §6.5, MercesIncome.submitReport, router.rs: public terms and zero-salt checkpoint binding.
describe.each(['solana','monad'] as const)('%s Stage 1 income router', (personality) => {
  it('routes actual receipts, binds a pure tier-1 report to both checkpoints, and credits the reported payment', async () => {
    const h = await SimHarness.create(personality,{genesis:GENESIS});
    const {seriesId,terms,privateTerms} = await h.runRaise({terms:{tierFlags:tiers}});
    const before = BigInt(await h.sim.getBalance(h.issuer.address,'USDC'));
    await h.exec(h.issuer,{kind:'routeIncome',seriesId,amount:USDC(100_000).toString()});
    // 10% of income above 60,000: 4,000 routed; the remaining 96,000 passes through.
    expect(BigInt(await h.sim.getBalance(h.issuer.address,'USDC'))).toBe(before-USDC(4000));
    expect((await h.sim.getRouter(seriesId))!.ytdReceived).toBe(USDC(100_000).toString());
    await h.sim.setTime(parsePeriod('2026Q1').end+1);
    const valid = await h.buildReport({seriesId,periodId:'2026Q1',privateTerms,incomeYtdNow:USDC(100_000),tier:1});
    await expectStage1Error(h.exec(h.issuer,valid.command),'RouterPeriodNotClosed');
    await h.sim.submit({kind:'closeRouterPeriod',seriesId,periodId:'2026Q1'},'keeper');
    const wrong = await h.buildReport({seriesId,periodId:'2026Q1',privateTerms,incomeYtdNow:USDC(100_001),tier:1});
    await expectStage1Error(h.exec(h.issuer,wrong.command),'InvalidProof');
    const salted = await h.buildReport({seriesId,periodId:'2026Q1',privateTerms,incomeYtdNow:USDC(100_000),incomeSalt:1n,tier:1});
    await expectStage1Error(h.exec(h.issuer,salted.command),'InvalidProof');
    const result = await h.reportAndPay(seriesId,'2026Q1',privateTerms,terms.termsCommitment,0n,USDC(100_000),{tier:1,source:'split'});
    expect(result.due).toBe(0n);
    expect(await h.sim.getPeriod(seriesId,'2026Q1')).toMatchObject({paymentStable:USDC(4000).toString(),splitReceived:USDC(4000).toString(),settled:true});
    const report = valid.command;
    expect(JSON.stringify(report)).not.toContain('incomeYtd');
  });

  it('refunds the issuer at the cap and passes subsequent receipts through after retirement', async () => {
    const h = await SimHarness.create(personality,{genesis:GENESIS});
    const {seriesId} = await h.runRaise({terms:{tierFlags:tiers}});
    const before=BigInt(await h.sim.getBalance(h.issuer.address,'USDC'));
    const result=await h.exec(h.issuer,{kind:'routeIncome',seriesId,amount:USDC(180_000).toString()});
    expect(result.events.find((e)=>e.type==='SplitReceipt')!.payload).toMatchObject({amount:USDC(11_250).toString()});
    expect(await h.sim.getSeries(seriesId)).toMatchObject({status:'Retired',refundedToIssuer:USDC(750).toString()});
    expect(BigInt(await h.sim.getBalance(h.issuer.address,'USDC'))).toBe(before-USDC(11_250));
    await h.exec(h.issuer,{kind:'routeIncome',seriesId,amount:USDC(5000).toString()});
    expect(BigInt(await h.sim.getBalance(h.issuer.address,'USDC'))).toBe(before-USDC(11_250));
    expect((await h.sim.getRouter(seriesId))!.ytdReceived).toBe(USDC(185_000).toString());
  });

  it('preserves the chain checkpoint retention and duplicate-close rules across a long gap',async()=>{
    const h=await SimHarness.create(personality,{genesis:GENESIS});
    const {seriesId}=await h.runRaise({terms:{tierFlags:tiers}});
    await h.exec(h.issuer,{kind:'routeIncome',seriesId,amount:USDC(50_000).toString()});
    await h.sim.setTime(parsePeriod('2029Q1').start);
    await h.sim.submit({kind:'closeRouterPeriod',seriesId,periodId:'2028Q4'},'keeper');
    const cps=(await h.sim.getRouter(seriesId))!.checkpoints;
    expect(cps).toHaveLength(personality==='solana'?8:12);
    expect(cps.find((p)=>p.periodId==='2028Q4')!.ytdAtEnd).toBe('0');
    if(personality==='monad') {
      expect(cps.find((p)=>p.periodId==='2026Q1')!.ytdAtEnd).toBe(USDC(50_000).toString());
      await h.sim.submit({kind:'closeRouterPeriod',seriesId,periodId:'2028Q4'},'keeper');
    } else await expectStage1Error(h.sim.submit({kind:'closeRouterPeriod',seriesId,periodId:'2028Q4'},'keeper'),'RouterPeriodAlreadyClosed');
  });
});

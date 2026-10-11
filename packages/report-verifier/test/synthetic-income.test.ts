import { describe, it, expect } from 'vitest';
import { incomeCommitment, signingDomain, ZERO_INCOME_COMMITMENT } from '@merces/domain';
import { LocalKms, MockZkTls, SyntheticIncomeZkTls, incomeProviderFromEnv, assertSyntheticIncomeNetwork } from '@merces/ports';
import { ReportVerifier } from '../src/verifier.ts';
import { verifierSetupFromEnv } from '../src/env.ts';
import { createVerifierServer } from '../src/server.ts';

const registry = '0x1111111111111111111111111111111111111111';
const seriesId = `monad:${registry}`, periodId = '2026Q1';
const chains = [{chain:'monad',domain:signingDomain('evm',10143,registry)}];
const fixture = new SyntheticIncomeZkTls(() => 1798761600);
const kms = new LocalKms('unit-test-synthetic-verifier-seed-long-enough', {'rv':'secp256k1'});

describe('explicit synthetic income on public test networks', () => {
  it('retains default live mock rejection and requires both opt-ins', () => {
    expect(() => incomeProviderFromEnv({}, {simulatorOnly:false})).toThrow(/simulator-only/);
    expect(() => incomeProviderFromEnv({MERCES_ZKTLS_PROVIDER:'synthetic'}, {simulatorOnly:false})).toThrow(/MERCES_TEST_INCOME/);
    expect(incomeProviderFromEnv({MERCES_ZKTLS_PROVIDER:'synthetic',MERCES_TEST_INCOME:'true'}, {simulatorOnly:false})).toBeInstanceOf(SyntheticIncomeZkTls);
  });
  it('accepts only the fixed completed-quarter Stripe fixture', async () => {
    const {proof} = fixture.fixture(seriesId,periodId);
    expect(await fixture.verify(proof,{seriesId,periodId})).toMatchObject({ok:true,source:'stripe',figure:350_000_000n,currency:'USD'});
    const arbitrary = new MockZkTls('merces/synthetic-stripe/v1').prove({source:'stripe',seriesId,periodId,figure:999n,currency:'USD',coversUntil:1775001600,owner:'synthetic-issuer'});
    expect((await fixture.verify(arbitrary,{seriesId,periodId})).ok).toBe(false);
    expect((await fixture.verify(proof,{seriesId,periodId:'2026Q2'})).ok).toBe(false);
    expect((await fixture.verify({...proof,system:'reclaim'},{seriesId,periodId})).ok).toBe(false);
    expect(() => fixture.fixture(seriesId,'2099Q1')).toThrow(/future quarter/);
  });
  it('never accepts mainnet, other testnets or local simulator domains', async () => {
    for (const id of [1,143,31337,11155111]) {
      const domain = signingDomain('evm',id,registry);
      expect(() => assertSyntheticIncomeNetwork(domain)).toThrow();
      await expect(ReportVerifier.create(fixture,kms,{keyId:'rv',chains:[{chain:'monad',domain}],allowLocal:true})).rejects.toThrow();
    }
  });
  it('requires a fresh verifier secret and address pin even with synthetic data', () => {
    const env = {MERCES_ZKTLS_PROVIDER:'synthetic',MERCES_TEST_INCOME:'true',MERCES_VERIFIER_CHAINS:JSON.stringify([{chain:'monad',family:'evm',chainKind:2,chainId:10143,registry}])};
    expect(() => verifierSetupFromEnv(env)).toThrow(/MERCES_LOCAL_KEY_SEED/);
    expect(() => verifierSetupFromEnv({...env,MERCES_LOCAL_KEY_SEED:'a-fresh-seed-with-more-than-32-characters'})).toThrow(/REPORT_VERIFIER_ADDRESS/);
    expect(verifierSetupFromEnv({...env,MERCES_LOCAL_KEY_SEED:'a-fresh-seed-with-more-than-32-characters',REPORT_VERIFIER_ADDRESS:registry}).config.allowLocal).toBe(false);
  });
  it('signs a bound fixture commitment, refuses another amount, and labels the key info', async () => {
    const verifier = await ReportVerifier.create(fixture,kms,{keyId:'rv',chains});
    expect((await verifier.publicKey()).syntheticIncome?.testOnly).toBe(true);
    const req = {seriesId,periodId,tier:2 as const,source:'stripe' as const,reportingCurrency:'USD',zktlsProof:fixture.fixture(seriesId,periodId).proof,incomeSalt:'123',incomeCommitment:incomeCommitment(350_000_000n,123n),priorIncomeCommitment:ZERO_INCOME_COMMITMENT};
    expect((await verifier.attest(req)).ok).toBe(true);
    expect(await verifier.attest({...req,incomeCommitment:incomeCommitment(1n,123n)})).toEqual({ok:false,code:'commitment-mismatch'});
  });
  it('serves synthetic proofs directly to an allowed browser without logging proof data', async () => {
    const verifier = await ReportVerifier.create(fixture,kms,{keyId:'rv',chains});
    const logs: string[] = [];
    const server = createVerifierServer(verifier,l => logs.push(l),{synthetic:fixture,allowedOrigins:['http://localhost:3001']});
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const address = server.address() as {port:number};
    const url = `http://127.0.0.1:${address.port}/synthetic/fixture`;
    try {
      const call = (origin: string, body: object) => fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
      expect((await call('https://untrusted.invalid',{seriesId,periodId})).status).toBe(403);
      expect((await call('http://localhost:3001',{seriesId,periodId,income:'999'})).status).toBe(400);
      const response = await call('http://localhost:3001',{seriesId,periodId});
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      expect(await response.json()).toMatchObject({testOnly:true,fixtureVersion:'merces/synthetic-stripe/v1',proof:{system:'mock'}});
      expect(logs.join('\n')).not.toMatch(/350000000|grossIncome|incomeSalt/);
    } finally {server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));}
  });
});

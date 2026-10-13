import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { IdentityService, ContractService, type ServiceContext } from '@merces/services';
import { MockESign } from '@merces/ports';
import { SimWallet } from '@merces/simulator';
import { signingDomain } from '@merces/domain';
import type { Session } from '../src/index.ts';
import { makeRig } from './helpers.ts';

describe.skipIf(!dbTestsEnabled())('disclosed trial onboarding on both chains', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
    rig.ctx.identity = {
      provider: 'operator-testnet',
      start: async ({ applicationId }) => ({ checkId: 'operator-testnet:' + applicationId, redirectUrl: 'about:blank' }),
      status: async id => (await rig.t.pool.query('select identity_status from applications where identity_check_id=$1', [id])).rows[0]?.identity_status === 'passed' ? 'passed' : 'pending',
    };
    rig.ctx.localOperator = { policy: { wallets: [], series: [] } } as unknown as ServiceContext['localOperator'];
  });
  afterAll(async () => { vi.unstubAllEnvs(); await rig.close(); });

  for (const chain of ['solana', 'monad'] as const) for (const kind of ['backer', 'issuer'] as const) {
    it(`${chain} ${kind}: own trial check, reload and submission do not grant eligibility`, async () => {
      const wallet = new SimWallet(chain === 'solana' ? 'solana' : 'evm', 'trial-' + kind).address;
      const accountId = `trial-${chain}-${kind}`;
      const identity = new IdentityService(rig.ctx);
      await identity.seedAccount({ accountId, wallets: [{ chain, address: wallet, family: chain === 'solana' ? 'solana' : 'evm' }], roles: ['backer'], eligible: false });
      rig.ctx.localOperator!.policy.wallets.push({ chain, address: wallet });
      const token = rig.token({ accountId, wallets: [{ chain, address: wallet }], roles: ['backer'], eligible: false });
      const created = await rig.post('/applications', { kind, chain, wallet, country: 'GB', ...(kind === 'issuer' ? { stablecoin: 'USDC', incomeSourceKinds: ['stripe'] } : {}) }, token);
      expect(created.statusCode).toBe(201);
      const id = created.json().applicationId, path = `/applications/${id}/identity/trial`;
      expect(created.json()).toMatchObject({ trialVerificationAvailable: true, identityTestOnly: false });
      expect((await rig.post(path, {}, token)).statusCode).toBe(400);
      expect((await rig.post(path, { acknowledgeSynthetic: false }, token)).statusCode).toBe(400);
      expect((await rig.post(path, { acknowledgeSynthetic: true }, rig.token({ accountId: 'other', roles: ['admin'] }))).statusCode).toBe(403);
      expect((await rig.post(path, { acknowledgeSynthetic: true }, rig.token({ accountId, wallets: [] }))).statusCode).toBe(403);
      vi.stubEnv('MERCES_LOCAL_PROVIDERS', 'true');
      expect((await rig.post(path, { acknowledgeSynthetic: true }, token)).statusCode).toBe(403);
      vi.unstubAllEnvs();
      const info = rig.ctx.chains.get(chain).info.bind(rig.ctx.chains.get(chain));
      const original = await info();
      const spy = vi.spyOn(rig.ctx.chains.get(chain), 'info').mockResolvedValue({ ...original, signing: signingDomain(chain === 'solana' ? 'solana' : 'evm', chain === 'solana' ? 101n : 143n, original.signing!.registry) });
      expect((await rig.post(path, { acknowledgeSynthetic: true }, token)).statusCode).toBe(403);
      spy.mockRestore();
      rig.ctx.localOperator!.policy.wallets.pop();
      expect((await rig.post(path, { acknowledgeSynthetic: true }, token)).statusCode).toBe(403);
      rig.ctx.localOperator!.policy.wallets.push({ chain, address: wallet });
      for (let i = 0; i < 2; i++) expect((await rig.post(path, { acknowledgeSynthetic: true }, token)).json()).toEqual({ status: 'passed', testOnly: true, realIdentityVerified: false });
      expect((await rig.get(`/applications/${id}`, token)).json()).toMatchObject({ state: 'draft', identityStatus: 'passed', identityTestOnly: true });
      expect((await rig.post(`/applications/${id}/identity/refresh`, {}, token)).json()).toEqual({ status: 'passed' });
      expect((await rig.post(`/applications/${id}/submit`, {}, token)).json().state).toBe('submitted');
      expect((await identity.sessionFor(accountId)).eligible).toBe(false);
      expect(await rig.ctx.chains.get(chain).isAllowlisted(wallet)).toBe(false);
      expect((await rig.t.pool.query("select count(*)::int as n from audit_log where action='identity.trial-completed' and target=$1", [id])).rows[0].n).toBe(1);
      await rig.t.pool.query("update applications set state='approved' where application_id=$1", [id]);
      expect((await rig.post(path, { acknowledgeSynthetic: true }, token)).statusCode).toBe(409);
    });
  }

  for (const chain of ['solana', 'monad'] as const) {
    it(`${chain}: resumes the exact unsigned documents after restart; signing and signed reads survive another restart`, async () => {
      const accountId = `trial-${chain}-issuer`, wallet = new SimWallet(chain === 'solana' ? 'solana' : 'evm', 'trial-issuer').address;
      const session: Session = { accountId, wallets: [{ chain, address: wallet }], roles: ['issuer'], eligible: true, exp: 0, iat: 0 };
      const draftId = 'restart-' + chain;
      await rig.t.pool.query("insert into series_drafts(draft_id,account_id,chain,issuer,public_terms,state,terms_commitment) values($1,$2,$3,$4,$5,'terms_set',$6)", [draftId, accountId, chain, wallet, { stablecoin: 'USDC', unitsOffered: '100', minimumRaise: '1000000' }, '123']);
      const ctx = { ...rig.ctx, esign: new MockESign(), testESign: true };
      const service = new ContractService(ctx);
      const first = await service.prepare(draftId, session);
      expect(JSON.stringify(first.documents)).toContain('100 bps on cleared bids and 500 bps on payouts');
      ctx.esign = new MockESign();
      expect((await service.status(draftId, session)).state).toBe('sent');
      const resumed = await service.prepare(draftId, session);
      expect(resumed.sessionId).toBe(first.sessionId);
      expect(resumed.documents).toEqual(first.documents);
      expect((await rig.t.pool.query('select count(*)::int as n from contract_sessions where draft_id=$1', [draftId])).rows[0].n).toBe(1);
      await expect(service.testSign(draftId, { ...session, accountId: 'other' })).rejects.toThrow();
      ctx.esign = new MockESign();
      await rig.t.pool.query("update series_drafts set terms_commitment='456' where draft_id=$1", [draftId]);
      await expect(service.testSign(draftId, session)).rejects.toThrow('draft terms changed');
      await rig.t.pool.query("update series_drafts set terms_commitment='123' where draft_id=$1", [draftId]);
      const signed = await service.testSign(draftId, session);
      expect(signed.state).toBe('signed');
      expect((await service.testSign(draftId, session)).signedHash).toBe(signed.signedHash);
      ctx.esign = new MockESign();
      expect((await service.status(draftId, session)).signedHash).toBe(signed.signedHash);
      const document = await service.signedDocument(draftId, session);
      expect(document.signedHash).toBe(signed.signedHash);
      expect(document.body).toContain('SIGNATURE AUDIT TRAIL (mock)');
      expect((await rig.t.pool.query('select state from series_drafts where draft_id=$1', [draftId])).rows[0].state).toBe('contract_signed');
      expect((await rig.t.pool.query("select count(*)::int as n from outbox where payload->>'draftId'=$1 and payload->>'kind'='contract.signed'", [draftId])).rows[0].n).toBe(1);
    });
  }
});

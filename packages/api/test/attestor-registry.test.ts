import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { IdentityService } from '@merces/services';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/** Stand-in for client-side encryption to the attestor's key: the server never sees the key. */
function e2e(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

/** A-M5-2: attestor access follows the indexed onchain registry of the addressed wallet itself, chain by chain. */
describe.skipIf(!dbTestsEnabled())('attestor access follows the indexed registry, wallet by wallet', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it("a wallet deactivated on one chain loses that chain's cases, even when another chain's registration passes the tier", async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise();
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'mon-issuer', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const until = (await h.sim.now()) + 30 * 86_400;
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('medical') }, issuerTok);
    expect(req.statusCode, req.body).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    const both = rig.token({ accountId: 'att-multi', roles: ['attestor'], wallets: [{ chain: 'solana', address: rig.sol.attestors[0]!.address }, { chain: 'monad', address: h.attestors[0]!.address }] });
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(200);

    // the multisig deactivates the monad wallet; once indexed, its cases close to this account
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: h.attestors[0]!.address, active: false });
    await rig.sync();
    expect((await rig.get(`/attestor/queue`, both)).statusCode).toBe(200); // the solana registration still passes the tier
    expect((await rig.get(`/attestor/queue`, both)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).not.toContain(hardshipId);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: false, decisionCode: 'declined' }, both)).statusCode).toBe(403);
    // work cannot be addressed to it either
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('x') }, issuerTok)).statusCode).toBe(422);
  });

  it('an admin can only propose a wallet the named account has linked', async () => {
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    const w = new SimWallet('solana', 'unlinked-attestor');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'acct-a', wallets: [], roles: ['backer'], eligible: false });
    const r = await rig.post('/admin/attestors', { chain: 'solana', wallet: w.address, accountId: 'acct-a', active: true }, adminTok);
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/not linked/);
  });
});

import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { KEY_GRACE_SECONDS, personalMessageDigest } from '@merces/domain';
import { toChecksumAddress } from '@merces/math';
import { SimSigner, SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/*
 * S4 cause codes:
 *  - S4-ID: attestors are keys (S4 WP7, D4; A-M5-2 revised). An attestor key is a secp256k1 key's 20-byte address on
 *    every chain, linked to an account by an EIP-191 proof made with the key itself (`/me/signer-keys`), never by a chain
 *    wallet or a sign-in. Access is per key and per chain, read live on every request: a key linked to the account and
 *    active and indexed on the item's chain. A sign-in nonce never links a key and a link challenge never signs in
 *    (amendment fix 2). The chains' key registries are public (`GET /chains/{chain}/signer-keys`), the links are not.
 */

/** Stand-in for client-side encryption to the attestor's key: the server never sees the key. */
function e2e(plain: string): string {
  const iv = randomBytes(12);
  // never a merces-e2e v1 version byte (0x01) first: one blob in 256 would otherwise parse as an envelope (a flake)
  if (iv[0] === 0x01) iv[0] = 0x00;
  const c = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

describe.skipIf(!dbTestsEnabled())('attestor keys: linked by their own proof, access per key and chain, read live (S4 WP7)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  /** A fresh account's token (no wallet, no role: neither decides attestor access). */
  const account = async (accountId: string): Promise<string> => {
    await rig.t.pool.query('insert into accounts (account_id) values ($1) on conflict do nothing', [accountId]);
    return rig.token({ accountId, wallets: [], roles: [] });
  };
  /** Register `key` as an attestor on solana and index it. */
  const registerOnSolana = async (key: { address: string }): Promise<void> => {
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: key.address });
    await rig.sync();
  };
  /** The challenge, then the key's EIP-191 proof of it. */
  const link = async (tok: string, key: SimSigner, sign: (message: string) => Promise<string> = (m) => key.personalSign(m)) => {
    const ch = await rig.post('/me/signer-keys/challenge', { address: key.address }, tok);
    expect(ch.statusCode, ch.body).toBe(200);
    return rig.post('/me/signer-keys', { address: key.address, nonce: ch.json().nonce, signature: await sign(ch.json().message) }, tok);
  };

  it('links a key with its EIP-191 proof of a challenge bound to the host, the account and the key; lists it with its registrations', async () => {
    const key = SimSigner.attestor('link-1');
    await registerOnSolana(key);
    const tok = await account('acct-link');
    // before the link the account is no attestor, whatever its token
    expect((await rig.get('/attestor/me', rig.token({ accountId: 'acct-link', wallets: [], roles: ['attestor'] }))).statusCode).toBe(403);

    // any case in; the challenge names the key in EIP-55 form and says what signing it does and does not do
    const ch = await rig.post('/me/signer-keys/challenge', { address: toChecksumAddress(key.address) }, tok);
    expect(ch.statusCode, ch.body).toBe(200);
    const { nonce, message, expiresAt } = ch.json() as { nonce: string; message: string; expiresAt: string };
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(message).toContain(`${rig.ctx.signInDomain} asks you to link an attestor key to your account.`);
    expect(message).toContain('Account: acct-link');
    expect(message).toContain(`Key: ${toChecksumAddress(key.address)}`);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain('It is not an attestation and it moves no funds.');
    // the stored challenge is chain-neutral, bound to the account, and for linking only
    expect((await rig.t.pool.query('select chain, address, purpose, account_id from auth_nonces where nonce = $1', [nonce])).rows[0]).toEqual({ chain: null, address: key.address, purpose: 'link-signer-key', account_id: 'acct-link' });

    const linked = await rig.post('/me/signer-keys', { address: key.address, nonce, signature: await key.personalSign(message) }, tok);
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json()).toMatchObject({ created: true, key: { address: key.address, registrations: [{ chain: 'solana', active: true, revokedAt: null, graceUntil: null }] } });
    // the refreshed token carries the role (informational: access is read live)
    expect(JSON.parse(Buffer.from((linked.json().token as string).split('.')[0]!, 'base64url').toString()).roles).toContain('attestor');
    const listed = await rig.get('/me/signer-keys', tok);
    expect(listed.json().keys).toEqual([{ address: key.address, linkedAt: expect.any(String), registrations: [{ chain: 'solana', active: true, registeredAt: expect.any(Number), revokedAt: null, graceUntil: null }] }]);
    // the same token (no role in it) now passes the attestor tier: the link and the indexed registry decide
    expect((await rig.get('/attestor/me', tok)).statusCode).toBe(200);
    expect((await rig.t.pool.query("select action, target from audit_log where action like 'signer-key.%' and actor = 'acct-link'")).rows).toEqual([{ action: 'signer-key.link', target: key.address }]);
    // a link proof is never an attestation: its digest is EIP-191's, whose pre-image starts with 0x19
    expect(personalMessageDigest(message)).not.toBe('0x' + Buffer.from(message).toString('hex'));
    // linking again (a new challenge) changes nothing
    const again = await link(tok, key);
    expect([again.statusCode, again.json().created]).toEqual([200, false]);
  });

  it('refuses every proof that is not the key\'s signature of a live challenge of this account for this key; a replay is 409', async () => {
    const key = SimSigner.attestor('link-2');
    const other = SimSigner.attestor('link-2-other');
    const tok = await account('acct-proof');
    const refused = async (body: Record<string, unknown>, status: number, reason: string, as = tok) => {
      const r = await rig.post('/me/signer-keys', body, as);
      expect([r.statusCode, r.json().detail], JSON.stringify(body).slice(0, 80)).toEqual([status, { reason }]);
    };
    const ch = (await rig.post('/me/signer-keys/challenge', { address: key.address }, tok)).json() as { nonce: string; message: string };
    const good = { address: key.address, nonce: ch.nonce, signature: await key.personalSign(ch.message) };
    // another key's signature, a simulator signature (never, even in dev mode), a malformed one, a raw-digest one
    await refused({ ...good, signature: await other.personalSign(ch.message) }, 422, 'bad-signature');
    await refused({ ...good, signature: await new SimWallet('evm', 'x', key.address).signMessage(new TextEncoder().encode(ch.message)) }, 422, 'bad-signature');
    await refused({ ...good, signature: 'sim:' + key.address }, 422, 'bad-signature');
    await refused({ ...good, signature: '0x' + '11'.repeat(65) }, 422, 'bad-signature');
    await refused({ ...good, signature: await key.signDigest(personalMessageDigest(ch.message).replace(/^0x../, '0x00')) }, 422, 'bad-signature');
    // a challenge issued to another account, for another key, or never
    const otherTok = await account('acct-proof-other');
    await refused(good, 422, 'unknown-challenge', otherTok);
    await refused({ ...good, address: other.address }, 422, 'unknown-challenge');
    await refused({ ...good, nonce: 'f'.repeat(32) }, 422, 'unknown-challenge');
    // an expired challenge
    const old = (await rig.post('/me/signer-keys/challenge', { address: key.address }, tok)).json() as { nonce: string; message: string };
    await rig.t.pool.query("update auth_nonces set expires_at = now() - interval '1 second' where nonce = $1", [old.nonce]);
    await refused({ address: key.address, nonce: old.nonce, signature: await key.personalSign(old.message) }, 422, 'challenge-expired');
    // shapes: a wallet address of another form, the zero address
    expect((await rig.post('/me/signer-keys/challenge', { address: rig.sol.issuer.address }, tok)).statusCode).toBe(400);
    expect((await rig.post('/me/signer-keys/challenge', { address: '0x' + '0'.repeat(40) }, tok)).json().detail).toEqual({ reason: 'zero-address' });
    expect((await rig.post('/me/signer-keys', { ...good, extra: 1 }, tok)).statusCode).toBe(400);
    // nothing was linked by any of these
    expect((await rig.get('/me/signer-keys', tok)).json().keys).toEqual([]);

    // the proof links once; the same challenge again is a replay
    expect((await rig.post('/me/signer-keys', good, tok)).statusCode).toBe(201);
    await refused(good, 409, 'challenge-used');
    expect((await rig.get('/me/signer-keys', tok)).json().keys.map((k: { address: string }) => k.address)).toEqual([key.address]);
    // unauthenticated: 401; a session of an account that does not exist: 404
    expect((await rig.post('/me/signer-keys/challenge', { address: key.address })).statusCode).toBe(401);
    expect((await rig.post('/me/signer-keys/challenge', { address: key.address }, rig.token({ accountId: 'no-such-account' }))).statusCode).toBe(404);
  });

  it('a key belongs to one account: a key linked to another account is 409 (after its proof), and nothing changes', async () => {
    const key = SimSigner.attestor('link-3');
    const a = await account('acct-owner');
    const b = await account('acct-taker');
    expect((await link(a, key)).statusCode).toBe(201);
    const taken = await link(b, key);
    expect([taken.statusCode, taken.json().detail]).toEqual([409, { reason: 'key-linked-to-another-account' }]);
    expect((await rig.t.pool.query('select account_id from account_signer_keys where address = $1', [key.address])).rows).toEqual([{ account_id: 'acct-owner' }]);
    expect((await rig.get('/me/signer-keys', b)).json().keys).toEqual([]);
  });

  it('purposes (amendment fix 2): a sign-in nonce never links a key, a link challenge never signs in, and a sign-in never links a key', async () => {
    const key = SimSigner.attestor('link-4');
    await registerOnSolana(key);
    const tok = await account('acct-purpose');
    // a sign-in nonce for the key's EVM wallet form, signed by the key: refused by the link route
    const signIn = (await rig.post('/auth/nonce', { chain: 'monad', address: key.address })).json() as { nonce: string; message: string };
    const viaSignIn = await rig.post('/me/signer-keys', { address: key.address, nonce: signIn.nonce, signature: await key.personalSign(signIn.message) }, tok);
    expect([viaSignIn.statusCode, viaSignIn.json().detail]).toEqual([422, { reason: 'unknown-challenge' }]);
    // a link challenge, signed by the key: refused by sign-in and by the wallet link
    const ch = (await rig.post('/me/signer-keys/challenge', { address: key.address }, tok)).json() as { nonce: string; message: string };
    const linkProof = await key.personalSign(ch.message);
    const asSignIn = await rig.post('/auth/verify', { chain: 'monad', address: key.address, message: ch.message, signature: linkProof });
    expect([asSignIn.statusCode, asSignIn.json().message]).toEqual([401, 'unknown nonce']);
    expect((await rig.post('/me/wallets/link', { chain: 'monad', address: key.address, message: ch.message, signature: linkProof }, tok)).statusCode).toBe(401);
    // and the challenge is still unspent: it links the key
    expect((await rig.post('/me/signer-keys', { address: key.address, nonce: ch.nonce, signature: linkProof }, tok)).statusCode).toBe(201);

    // a real EIP-191 sign-in with another registered key's wallet form makes an account with that wallet, never a key
    // link: no attestor access
    const signer = SimSigner.attestor('link-4-signin');
    await registerOnSolana(signer);
    const n = (await rig.post('/auth/nonce', { chain: 'monad', address: signer.address })).json() as { message: string };
    const v = await rig.post('/auth/verify', { chain: 'monad', address: signer.address, message: n.message, signature: await signer.personalSign(n.message) });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().account.wallets).toEqual([{ chain: 'monad', address: signer.address }]);
    expect(v.json().account.roles).not.toContain('attestor');
    expect((await rig.get('/attestor/me', v.json().token)).statusCode).toBe(403);
    expect((await rig.get('/me/signer-keys', v.json().token)).json().keys).toEqual([]);
  });

  it('revocation ends access on the next request, with the same token; unlinking ends it too, and is refused while work is open', async () => {
    const key = SimSigner.attestor('link-5');
    await registerOnSolana(key);
    const tok = await account('acct-live');
    expect((await link(tok, key)).statusCode).toBe(201);
    expect((await rig.get('/attestor/queue', tok)).statusCode).toBe(200);
    // revoked onchain and indexed: the same token gets 403 at once (A-M5-2); re-registered: access again
    await rig.sol.exec(rig.sol.admin, { kind: 'revokeAttestor', attestor: key.address });
    await rig.sync();
    expect((await rig.get('/attestor/queue', tok)).statusCode).toBe(403);
    const listed = (await rig.get('/me/signer-keys', tok)).json().keys[0].registrations[0];
    expect(listed).toMatchObject({ chain: 'solana', active: false, graceUntil: listed.revokedAt + KEY_GRACE_SECONDS });
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: key.address });
    await rig.sync();
    expect((await rig.get('/attestor/queue', tok)).statusCode).toBe(200);

    // work addressed to the key holds the link: a pending hardship request
    const h = rig.sol;
    const { seriesId } = await h.runRaise();
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'iss-live', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const hs = await rig.post(`/series/${seriesId}/hardship`, { until: (await h.sim.now()) + 30 * 86_400, attestor: key.address, ciphertext: e2e('reason') }, issuerTok);
    expect(hs.statusCode, hs.body).toBe(201);
    const held = await rig.del(`/me/signer-keys/${key.address}`, tok);
    expect([held.statusCode, held.json().detail]).toEqual([409, { reason: 'open-work', openWork: { hardship: 1, tier3: 0, annual: 0, extinguishments: 0, amendments: 0 } }]);
    expect((await rig.post(`/attestor/hardship/${hs.json().hardshipId}/decide`, { approve: false, decisionCode: 'declined' }, tok)).statusCode).toBe(200);
    // another account cannot unlink it; then the holder does, and access ends with the same token
    expect((await rig.del(`/me/signer-keys/${key.address}`, await account('acct-intruder'))).statusCode).toBe(404);
    const gone = await rig.del(`/me/signer-keys/${toChecksumAddress(key.address)}`, tok);
    expect([gone.statusCode, gone.json()]).toEqual([200, { address: key.address, unlinked: true }]);
    expect((await rig.get('/attestor/queue', tok)).statusCode).toBe(403);
    expect((await rig.get('/me/signer-keys', tok)).json().keys).toEqual([]);
    expect((await rig.del(`/me/signer-keys/${key.address}`, tok)).statusCode).toBe(404);
    expect((await rig.t.pool.query("select action from audit_log where actor = 'acct-live' and action like 'signer-key.%' order by id")).rows.map((r) => r.action)).toEqual(['signer-key.link', 'signer-key.unlink']);
  });

  it("another chain's registration never stands in: a key registered on solana only reads no monad series' items", async () => {
    const key = SimSigner.attestor('link-6');
    await registerOnSolana(key);
    const tok = await account('acct-chain');
    expect((await link(tok, key)).statusCode).toBe(201);
    const [sol, mon] = [await rig.sol.runRaise(), await rig.mon.runRaise()];
    await rig.sync();
    expect((await rig.get(`/series/${sol.seriesId}/amendments`, tok)).statusCode).toBe(200);
    expect((await rig.get(`/series/${mon.seriesId}/amendments`, tok)).statusCode).toBe(403);
    // work cannot be addressed to it on monad
    const monIssuer = rig.token({ accountId: 'iss-mon', wallets: [{ chain: 'monad', address: rig.mon.issuer.address }], roles: ['issuer'] });
    expect((await rig.post(`/series/${mon.seriesId}/hardship`, { until: (await rig.mon.sim.now()) + 30 * 86_400, attestor: key.address, ciphertext: e2e('reason') }, monIssuer)).statusCode).toBe(422);
    // its profile shows the key on each chain with its registration there
    expect((await rig.get('/attestor/me', tok)).json().keys).toEqual([{ chain: 'monad', address: key.address, registeredOnchain: false }, { chain: 'solana', address: key.address, registeredOnchain: true }]);
  });

  it('the public read of a chain\'s key registry: addresses, active, revocation and grace; never an account', async () => {
    const r = await rig.get('/chains/solana/signer-keys?kind=attestor');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ chain: 'solana', kind: 'attestor' });
    const keys = r.json().keys as { address: string; active: boolean; revokedAt: number | null; graceUntil: number | null }[];
    for (const a of rig.sol.attestors) expect(keys).toContainEqual({ address: a.address, active: true, revokedAt: null, graceUntil: null });
    for (const k of keys) expect(Object.keys(k).sort()).toEqual(['active', 'address', 'graceUntil', 'revokedAt']);
    // keys linked to accounts above appear by address only
    expect(r.body).not.toMatch(/acct-|account/);
    const v = await rig.get('/chains/monad/signer-keys?kind=verifier');
    // the harness's own verifier key and the rig's report verifier's
    expect(v.json().keys).toEqual([{ address: await rig.kms.signerAddress('report-verifier-test'), active: true, revokedAt: null, graceUntil: null }, { address: rig.mon.verifier.address, active: true, revokedAt: null, graceUntil: null }].sort((a, b) => (a.address < b.address ? -1 : 1)));
    expect((await rig.get('/chains/nowhere/signer-keys?kind=attestor')).statusCode).toBe(404);
    expect((await rig.get('/chains/solana/signer-keys?kind=issuer')).statusCode).toBe(400);
    expect((await rig.get('/chains/solana/signer-keys')).statusCode).toBe(400);
  });
});

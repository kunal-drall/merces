import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { amendDigest, recoverSigner, termsCommitment, type SignedTx, type SigningRequest, type UnsignedTx } from '@merces/domain';
import { deriveTestPrivateKey } from '@merces/math/testing';
import { AttestorKey, checkRequest, describeSigningRequest, pinNetworks, signRequest } from '@merces/poi-device';
import { SimSigner, SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/*
 * S2 cause codes:
 *  - S2-AD: commit and reveal durations are series terms (Stage 1's defaults for a new series).
 *
 * S3 follow-up cause code:
 *  - NRC: the non-reveal charge is the owner's setting (was S2-NRC, the hold: new series recorded 0 bps). A new series
 *    records the operator's rate (the rig sets 100 bps); while it is unset, a sealed raise is refused (409, naming the
 *    setting) and issuers cannot choose it.
 *
 * S4 cause codes:
 *  - S4-ID: attestors are keys linked to an account (S4 WP7): an amendment is attested with `attestor` (a key linked to
 *    the caller's account and active and indexed on the series' chain; was `attestorWallet`, a wallet of the session).
 *  - S4-AMD: an approval is the key's Stage 1 AMEND signature over the series' live amendment nonce, made on the
 *    attestor's device from `GET /attestor/amendments/{id}/message` (S4 WP11; was `{attestor, approve}` with the key
 *    co-signing the issuer's transaction); the issuer's amendTerms carries it and nobody co-signs.
 *  - S4-CS: nobody co-signs (S4 WP13): `UnsignedTx` has one `signer` and no co-signer field; an attestor is a key, never
 *    a wallet (was a co-signer list, empty since the flows moved to signature arguments).
 */

/** Sign in a simulator wallet through the real nonce/verify flow. */
async function signIn(rig: Awaited<ReturnType<typeof makeRig>>, chain: string, wallet: SimWallet, linkToken?: string): Promise<string> {
  const n = await rig.post('/auth/nonce', { chain, address: wallet.address });
  expect(n.statusCode).toBe(200);
  const { message } = n.json();
  const signature = await wallet.signMessage(new TextEncoder().encode(message));
  const v = linkToken ? await rig.post('/me/wallets/link', { chain, address: wallet.address, message, signature }, linkToken) : await rig.post('/auth/verify', { chain, address: wallet.address, message, signature });
  expect(v.statusCode).toBe(200);
  return v.json().token as string;
}

describe.skipIf(!dbTestsEnabled())('M2 people and paper (E2, E3, E4)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let adminTok: string;
  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('E2: wallet sign-in creates an account; a second-family wallet links to it; bad signatures and replays fail', async () => {
    const sol = new SimWallet('solana', 'user-a');
    const evm = new SimWallet('evm', 'user-a');
    const tok = await signIn(rig, 'solana', sol);
    const me = await rig.get('/me', tok);
    expect(me.json().roles).toEqual(['backer']);
    expect(me.json().eligible).toBe(false);
    const tok2 = await signIn(rig, 'monad', evm, tok);
    const me2 = await rig.get('/me', tok2);
    expect(me2.json().wallets.map((w: { chain: string }) => w.chain).sort()).toEqual(['monad', 'solana']);
    // replay of the same message fails (nonce used)
    const n = await rig.post('/auth/nonce', { chain: 'solana', address: sol.address });
    const { message } = n.json();
    const sig = await sol.signMessage(new TextEncoder().encode(message));
    expect((await rig.post('/auth/verify', { chain: 'solana', address: sol.address, message, signature: sig })).statusCode).toBe(200);
    expect((await rig.post('/auth/verify', { chain: 'solana', address: sol.address, message, signature: sig })).statusCode).toBe(401);
    expect((await rig.post('/auth/verify', { chain: 'solana', address: sol.address, message, signature: 'sim:deadbeef' })).statusCode).toBe(401);
    // the wallet cannot be linked to a second account
    const other = await signIn(rig, 'solana', new SimWallet('solana', 'user-b'));
    const n2 = await rig.post('/auth/nonce', { chain: 'monad', address: evm.address });
    const m2 = n2.json().message;
    const link = await rig.post('/me/wallets/link', { chain: 'monad', address: evm.address, message: m2, signature: await evm.signMessage(new TextEncoder().encode(m2)) }, other);
    expect(link.statusCode).toBe(409);
  });

  it('E2: issuer application → identity → review → approval syncs the chain allowlist; revocation removes it', async () => {
    const w = new SimWallet('evm', 'applicant-1');
    const tok = await signIn(rig, 'monad', w);
    expect(await rig.mon.sim.isAllowlisted(w.address)).toBe(false);
    const created = await rig.post('/applications', { kind: 'issuer', chain: 'monad', wallet: w.address, stablecoin: 'USDC', persona: 'engineer', country: 'DE', incomeSourceKinds: ['deel'], notes: 'relocating for research' }, tok, { 'idempotency-key': 'app-1' });
    expect(created.statusCode).toBe(201);
    const appId = created.json().applicationId;
    // idempotent replay returns the same application
    const replay = await rig.post('/applications', { kind: 'issuer', chain: 'monad', wallet: w.address, stablecoin: 'USDC', persona: 'engineer', country: 'DE', incomeSourceKinds: ['deel'], notes: 'relocating for research' }, tok, { 'idempotency-key': 'app-1' });
    expect(replay.json().applicationId).toBe(appId);
    // USDG is not on monad
    expect((await rig.post('/applications', { kind: 'issuer', chain: 'monad', wallet: w.address, stablecoin: 'USDG', country: 'DE' }, tok)).statusCode).toBe(400);
    // notes are encrypted at rest
    const row = await rig.t.pool.query('select notes_encrypted from applications where application_id = $1', [appId]);
    expect(row.rows[0].notes_encrypted).not.toContain('relocating');
    const readiness = await rig.get(`/applications/${appId}/readiness`, tok);
    expect(readiness.json().ready).toBe(false);
    expect(readiness.json().items.find((i: { check: string }) => i.check === 'identity').ok).toBe(false);
    // approval before identity passes is refused
    await rig.post(`/applications/${appId}/submit`, {}, tok);
    expect((await rig.post(`/admin/applications/${appId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok)).statusCode).toBe(422);
    const idc = await rig.post(`/applications/${appId}/identity/start`, {}, tok);
    expect(idc.json().status).toBe('passed');
    expect((await rig.get(`/applications/${appId}/readiness`, tok)).json().ready).toBe(true);
    // non-admin cannot review
    expect((await rig.get('/admin/applications', tok)).statusCode).toBe(403);
    const queue = await rig.get('/admin/applications?state=submitted', adminTok);
    expect(queue.json().applications.map((a: { applicationId: string }) => a.applicationId)).toContain(appId);
    const decided = await rig.post(`/admin/applications/${appId}/decide`, { decision: 'approved', reasonCode: 'review-ok' }, adminTok);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe('approved');
    expect(await rig.mon.sim.isAllowlisted(w.address)).toBe(true);
    const refreshed = await rig.post('/me/session/refresh', {}, tok);
    expect(refreshed.json().account.roles).toContain('issuer');
    expect(refreshed.json().account.eligible).toBe(true);
    const audit = await rig.t.pool.query("select action from audit_log where target = $1 or target = $2 order by id", [appId, `monad:${w.address}`]);
    expect(audit.rows.map((r) => r.action)).toEqual(['application.approved', 'allowlist.add']);
    // revocation: off the allowlist; the chain still lets the wallet claim (C10 is enforced by the simulator tests)
    expect((await rig.post(`/admin/eligibility/monad/${w.address}/revoke`, { reasonCode: 'compliance' }, adminTok)).statusCode).toBe(200);
    expect(await rig.mon.sim.isAllowlisted(w.address)).toBe(false);
    const again = await rig.post('/me/session/refresh', {}, tok);
    expect(again.json().account.eligible).toBe(false);
  });

  it('E4 + E3: terms validation, vault, contract signing, createSeries anchoring, disclosure and an inflation amendment', async () => {
    const issuer = new SimWallet('solana', 'issuer-draft');
    const tok = await signIn(rig, 'solana', issuer);
    // not an approved issuer yet
    expect((await rig.post('/drafts', { chain: 'solana', issuer: issuer.address }, tok)).statusCode).toBe(403);
    // approve through the real flow
    const app = (await rig.post('/applications', { kind: 'issuer', chain: 'solana', wallet: issuer.address, stablecoin: 'USDC', country: 'US', incomeSourceKinds: ['stripe'] }, tok)).json();
    await rig.post(`/applications/${app.applicationId}/identity/start`, {}, tok);
    await rig.post(`/applications/${app.applicationId}/submit`, {}, tok);
    await rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok);
    const issuerTok = (await rig.post('/me/session/refresh', {}, tok)).json().token as string;

    const pub = { stablecoin: 'USDC', unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', country: 'US' };
    // validation: below the floor, bad cap, bps
    const bad = await rig.post('/terms/validate', { chain: 'solana', public: { ...pub, capMultiple: '3.5', releaseSchedule: [{ afterSeconds: 0, bps: 5000 }] }, private: { threshold: '10000000000', shareRate: '0.10' } }, issuerTok);
    expect(bad.json().issues.map((i: { code: string }) => i.code).sort()).toEqual(['below-floor', 'bps-sum', 'out-of-bounds']);
    expect(bad.json().derived.floorPlaceholder).toBe(true);
    const ok = await rig.post('/terms/validate', { chain: 'solana', public: pub, private: { threshold: '65000000000', shareRate: '0.10' } }, issuerTok);
    expect(ok.json().issues).toEqual([]);
    expect(ok.json().derived.ratePerUnitWad).toBe('100000000000000');

    const draft = (await rig.post('/drafts', { chain: 'solana', issuer: issuer.address }, issuerTok)).json();
    expect(draft.state).toBe('draft');
    expect((await rig.post(`/drafts/${draft.draftId}/build-create-series`, {}, issuerTok)).statusCode).toBe(409);
    expect((await rig.put(`/drafts/${draft.draftId}/terms`, { public: pub, private: { threshold: '10', shareRate: '0.10' } }, issuerTok)).statusCode).toBe(422);
    const set = await rig.put(`/drafts/${draft.draftId}/terms`, { public: pub, private: { threshold: '65000000000', shareRate: '0.10' } }, issuerTok);
    expect(set.statusCode).toBe(200);
    expect(set.json().state).toBe('terms_set');
    expect(set.json().termsCommitment).toMatch(/^0x/);
    expect(JSON.stringify(set.json().publicTerms)).not.toContain('65000000000');
    // the vault holds ciphertext only
    const vault = await rig.t.pool.query('select ciphertext from terms_vault where draft_id = $1', [draft.draftId]);
    expect(vault.rows[0].ciphertext).not.toContain('65000000000');
    const priv = (await rig.get(`/drafts/${draft.draftId}/terms/private`, issuerTok)).json();
    expect(priv.terms.threshold).toBe('65000000000');
    // the opening of Stage 1's Poseidon terms commitment, with the codes the circuit takes (cause PF, S1: the terms
    // commitment is Stage 1's Poseidon(5) over θ, r, the ISO-4217 numeric currency, the indexing rule code and a field
    // salt; was SHA-256 over canonical JSON with a hex `salt`)
    expect(priv.terms).toMatchObject({ scheme: 'poseidon5-v1', reportingCurrency: 'USD', currencyCode: 840, indexingRule: 'cpi-annual', indexingRuleCode: 1 });
    expect(priv.terms.termsSalt).toMatch(/^\d{1,78}$/);
    // the whole disclosed payload can be posted as is
    expect((await rig.post('/terms/commitment', priv.terms)).json()).toEqual({ commitment: priv.commitment, scheme: 'poseidon5-v1' });
    const recomputed = (await rig.post('/terms/commitment', { threshold: priv.terms.threshold, ratePerUnitWad: priv.terms.ratePerUnitWad, reportingCurrency: priv.terms.reportingCurrency, indexingRule: priv.terms.indexingRule, termsSalt: priv.terms.termsSalt })).json();
    expect(recomputed.commitment).toBe(priv.commitment);

    // contract: prepare → (mock) sign → hash anchored → createSeries
    expect((await rig.post(`/drafts/${draft.draftId}/build-create-series`, {}, issuerTok)).statusCode).toBe(409);
    const prep = await rig.post(`/drafts/${draft.draftId}/contract/prepare`, {}, issuerTok);
    expect(prep.statusCode).toBe(200);
    expect(prep.json().documents.map((d: { name: string }) => d.name)).toEqual(['HEU Contract', 'Autonomy Charter']);
    expect(prep.json().documents[1].body).toContain('Units carry no vote');
    expect((await rig.get(`/drafts/${draft.draftId}/contract`, issuerTok)).json().state).toBe('sent');
    const done = await rig.post('/dev/esign/complete', { sessionId: prep.json().sessionId });
    expect(done.json().state).toBe('signed');
    const signedHash = done.json().signedHash as string;
    expect(signedHash).toMatch(/^0x[0-9a-f]{64}$/);
    const doc = await rig.get(`/drafts/${draft.draftId}/contract/document`, issuerTok);
    expect(doc.json().body).toContain('SIGNATURE AUDIT TRAIL');
    // cause NRC: with the owner's setting unset, no sealed series is built: 409, naming the setting, never a value
    rig.ctx.nonRevealChargeBps = null;
    const unset = await rig.post(`/drafts/${draft.draftId}/build-create-series`, {}, issuerTok);
    expect([unset.statusCode, unset.json().detail]).toEqual([409, { setting: 'MERCES_NON_REVEAL_CHARGE_BPS' }]);
    expect(unset.json().message).toMatch(/^the non-reveal charge for new series is not set: .*MERCES_NON_REVEAL_CHARGE_BPS \(whole bps, 0 to 1000; the owner's decision\)$/);
    rig.ctx.nonRevealChargeBps = 100;
    const built = await rig.post(`/drafts/${draft.draftId}/build-create-series`, {}, issuerTok);
    expect(built.statusCode).toBe(200);
    const tx = built.json().tx as UnsignedTx;
    expect(tx.command.kind).toBe('createSeries');
    expect((tx.command as { terms: { contractHash: string; termsCommitment: string } }).terms.contractHash).toBe(signedHash);
    // cause S2-AD / NRC: the raise's own terms are filled in: Stage 1's 7-day commit and 2-day reveal, and the owner's
    // non-reveal charge (the rig's 100 bps; was 0 under the S2 hold)
    expect((tx.command as { terms: Record<string, unknown> }).terms).toMatchObject({ commitDurationSeconds: 604_800, revealDurationSeconds: 172_800, nonRevealChargeBps: 100 });
    // the issuer must be registered on chain first (registerIssuer), then createSeries
    const reg = await rig.sol.sim.build({ kind: 'registerIssuer' }, issuer.address);
    expect((await rig.post('/tx/send', await issuer.sign(reg), issuerTok)).statusCode).toBe(200);
    const signed: SignedTx = await issuer.sign(tx);
    // a stranger cannot relay someone else's signed tx
    expect((await rig.post('/tx/send', signed, rig.token({ accountId: 'x', wallets: [{ chain: 'solana', address: 'nobody' }] }))).statusCode).toBe(403);
    const sent = await rig.post('/tx/send', signed, issuerTok);
    expect(sent.statusCode).toBe(200);
    expect(sent.json().events[0].type).toBe('SeriesCreated');
    await rig.sync();
    const linked = await rig.post(`/drafts/${draft.draftId}/link-created`, {}, issuerTok);
    expect(linked.json().state).toBe('created');
    const seriesId = linked.json().seriesId as string;
    expect((await rig.get(`/series/${seriesId}`)).json().terms.contractHash).toBe(signedHash);

    // disclosure: eligible backer yes, ineligible no, each access logged
    const backer = new SimWallet('solana', 'backer-disc');
    const bTok = await signIn(rig, 'solana', backer);
    expect((await rig.get(`/series/${seriesId}/terms`, bTok)).statusCode).toBe(403);
    const bApp = (await rig.post('/applications', { kind: 'backer', chain: 'solana', wallet: backer.address, country: 'GB' }, bTok)).json();
    await rig.post(`/applications/${bApp.applicationId}/identity/start`, {}, bTok);
    await rig.post(`/applications/${bApp.applicationId}/submit`, {}, bTok);
    await rig.post(`/admin/applications/${bApp.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok);
    const bTok2 = (await rig.post('/me/session/refresh', {}, bTok)).json().token as string;
    const disclosed = await rig.get(`/series/${seriesId}/terms`, bTok2);
    expect(disclosed.statusCode).toBe(200);
    expect(disclosed.json().terms.threshold).toBe('65000000000');
    const log = await rig.get(`/series/${seriesId}/terms/access-log`, issuerTok);
    expect(log.json().accesses.map((a: { purpose: string }) => a.purpose)).toEqual(['backer-disclosure']);

    // inflation amendment: propose → an attestor key signs Stage 1's AMEND message on its device → the issuer builds
    // amendTerms carrying the signature → send → apply (cause S4-AMD: was attest {attestor, approve}, then the key
    // co-signing the issuer's transaction)
    const attestor = rig.sol.attestors[0]!;
    const attTok = await rig.attestorToken('att-1', [attestor]); // cause S4-ID: the key is linked to the account
    const prop = await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2026 }, issuerTok, { 'idempotency-key': 'k-amend' });
    expect(prop.statusCode).toBe(200);
    expect(prop.json().inflationBps).toBe(300);
    expect(prop.json().note).toContain('AMEND message');
    const amendmentId = prop.json().amendmentId as string;
    const newCommitment = prop.json().newCommitment as string;
    // a retried proposal with the same key replays the first one instead of creating a second amendment
    const retry = await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2026 }, issuerTok, { 'idempotency-key': 'k-amend' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(prop.json());
    expect((await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2027 }, issuerTok, { 'idempotency-key': 'k-amend' })).statusCode).toBe(409);
    expect((await rig.get(`/series/${seriesId}/amendments`, issuerTok)).json().amendments.map((a: { amendmentId: string }) => a.amendmentId)).toEqual([amendmentId]);
    expect((await rig.post(`/amendments/${amendmentId}/build`, {}, issuerTok)).statusCode).toBe(409);
    const cap = (await rig.sol.sim.getSeries(seriesId))!.terms.capMultipleWad;
    // cause S4-ID: only a key linked to the caller's account that the series' chain has registered (and the indexer shows)
    // may sign or decide. A key registered on monad only is refused for a solana series (the tier passes on monad)
    const monOnly = SimSigner.attestor('pp-monad-only');
    await rig.mon.exec(rig.mon.admin, { kind: 'registerAttestor', attestor: monOnly.address });
    const second = SimSigner.attestor('pp-second');
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: second.address });
    await rig.sync();
    const wrongChain = await rig.attestorToken('att-2', [monOnly]);
    const onMonad = await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${monOnly.address}`, wrongChain);
    expect([onMonad.statusCode, onMonad.json().message]).toEqual([422, `${monOnly.address} is not a registered attestor key on solana`]);
    // cause S4-AMD: its signature, made over the series' real message, is refused before it is read
    const monSig = await rig.sol.attestAmend(seriesId, { termsCommitment: newCommitment, capMultipleWad: cap }, monOnly);
    const monBody = { approve: true, amendmentNonce: '0', attestation: monSig };
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, monBody, wrongChain)).json().message).toBe(`${monOnly.address} is not a registered attestor key on solana`);
    const unreg = SimSigner.attestor('attestor-unregistered');
    const unregTok = await rig.attestorToken('att-3', [unreg]);
    // an unregistered key never reaches the attestor routes, whatever role its token claims (A-M5-2)
    expect((await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${unreg.address}`, unregTok)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, { approve: false, attestor: attestor.address }, unregTok)).statusCode).toBe(403);
    // a registered attestor naming a linked key the chain has not registered is refused by the service, and naming a
    // registered key linked to another account is forbidden
    const unreg2 = SimSigner.attestor('attestor-unregistered-2');
    const twoKeys = await rig.attestorToken('att-4', [second, unreg2]);
    const refused = await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${unreg2.address}`, twoKeys);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain('not a registered attestor');
    expect((await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${attestor.address}`, twoKeys)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, { approve: false, attestor: attestor.address }, twoKeys)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/amendments`, issuerTok)).json().amendments[0].state).toBe('proposed');

    // cause S4-AMD: the signing request: Stage 1's AMEND message over the chain's signing domain, the series key, the live
    // amendment nonce, the new commitment and the cap; public data only, also for an admin (who never decides)
    const msg = await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${attestor.address}`, attTok);
    expect(msg.statusCode, msg.body).toBe(200);
    const signing = (await rig.sol.sim.info()).signing!;
    const seriesKey = (await rig.sol.sim.getSeries(seriesId))!.seriesKey;
    expect(msg.json()).toMatchObject({ kind: 'AMEND', chain: 'solana', seriesId, seriesKey, domain: signing, signer: attestor.address, fields: { amendmentNonce: '0', termsCommitment: newCommitment, capMultipleWad: cap }, validWhile: 'amendment nonce 0' });
    expect(msg.json().digest).toBe(amendDigest({ domain: signing.domain, seriesKey }, { amendmentNonce: 0n, termsCommitment: newCommitment, capMultipleWad: cap }).digest);
    expect((await rig.get(`/attestor/amendments/${amendmentId}/message?attestor=${attestor.address}`, adminTok)).statusCode).toBe(200);
    expect((await rig.get(`/attestor/amendments/${amendmentId}/message`, attTok)).statusCode).toBe(400);
    // the attestor's device: its own pinned networks and key; it shows what is authorised from the typed fields and
    // refuses a request whose cap was changed under the digest
    const request = msg.json() as SigningRequest<'AMEND'>;
    const pinned = pinNetworks({ solana: signing }, { allowLocal: true });
    const device = AttestorKey.fromPrivateKey(deriveTestPrivateKey(attestor.key.seed));
    expect(() => signRequest({ ...request, fields: { ...request.fields, capMultipleWad: '2000000000000000000' } }, device, pinned, { allowLocal: true })).toThrow();
    expect(describeSigningRequest(checkRequest(request, pinned, { allowLocal: true })).join('\n')).toMatch(/^Terms amendment \(MERCES_AMEND_V1\) at amendment nonce 0/);
    const sig = signRequest(request, device, pinned, { allowLocal: true });
    device.wipe();
    expect(recoverSigner(sig.digest, sig.signature)).toBe(attestor.address);
    const body = { approve: true, amendmentNonce: request.fields.amendmentNonce, attestation: sig };
    // the body's shape: the old {attestor, approve}, no signature, a sim co-signature, extra fields
    for (const bad of [{ attestor: attestor.address, approve: true }, { approve: true }, { ...body, attestation: { ...sig, signature: 'sim:' + attestor.address } }, { ...body, extra: 1 }, { approve: false }]) {
      expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, bad, attTok)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // the API recovers the signer over the AMEND message it rebuilds from the chain's reads (never the caller's digest):
    // another key's signature, a digest that is not this message, a signature over another nonce: 422
    // InvalidAttestorSignature, nothing recorded
    const refusedSig = async (b: unknown) => {
      const r = await rig.post(`/attestor/amendments/${amendmentId}/attest`, b, attTok);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().detail).toEqual({ stage1: 'InvalidAttestorSignature' });
    };
    const otherKey = await rig.sol.attestAmend(seriesId, { termsCommitment: newCommitment, capMultipleWad: cap }, rig.sol.attestors[1]!);
    await refusedSig({ ...body, attestation: { signer: attestor.address, signature: otherKey.signature } });
    await refusedSig({ ...body, attestation: { ...sig, digest: '0x' + '00'.repeat(32) } });
    await refusedSig({ ...body, amendmentNonce: '1' });
    expect((await rig.get(`/series/${seriesId}/amendments`, issuerTok)).json().amendments[0].state).toBe('proposed');
    const att = await rig.post(`/attestor/amendments/${amendmentId}/attest`, body, attTok);
    expect(att.statusCode, att.body).toBe(200);
    expect(att.json()).toEqual({ amendmentId, state: 'attested', favourable: true, attestor: attestor.address, amendmentNonce: '0', digest: sig.digest });
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, body, attTok)).statusCode).toBe(409);
    // the unrelayed signature is never listed (S4 amendment D2): the nonce and digest are
    const listed = await rig.get(`/series/${seriesId}/amendments`, issuerTok);
    expect(listed.json().amendments[0]).toMatchObject({ state: 'attested', attestor: attestor.address, amendmentNonce: '0', digest: sig.digest });
    expect(listed.body).not.toContain(sig.signature.slice(2));
    const b2 = await rig.post(`/amendments/${amendmentId}/build`, {}, issuerTok);
    expect(b2.statusCode, b2.body).toBe(200);
    const atx = b2.json().tx as UnsignedTx;
    // cause S4-AMD: the issuer's transaction carries the AMEND signature; cause S4-CS: nobody co-signs (one signer, no
    // co-signer field)
    expect(Object.keys(atx).sort()).toEqual(['chain', 'command', 'encoding', 'expiresAt', 'family', 'payload', 'signer', 'summary']);
    expect(atx.command).toEqual({ kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: cap, attestor: attestor.address, signature: sig.signature });
    const res = await rig.post('/tx/send', await issuer.sign(atx), issuerTok);
    expect(res.statusCode).toBe(200);
    expect(res.json().events[0].type).toBe('TermsAmended');
    expect(res.json().events[0].payload).toMatchObject({ attestor: attestor.address, nonce: '0' });
    await rig.sync();
    expect((await rig.post(`/amendments/${amendmentId}/apply`, {}, issuerTok)).statusCode).toBe(200);
    const after = (await rig.get(`/series/${seriesId}/terms`, bTok2)).json();
    expect(after.terms.threshold).toBe('66950000000');
    expect(after.version).toBe(2);
    // the amended commitment is Stage 1's Poseidon(5) over the indexed θ (cause PF)
    expect(after.commitment).toBe(termsCommitment({ theta: '66950000000', rWad: after.terms.ratePerUnitWad, currency: 'USD', indexingRule: 'cpi-annual', termsSalt: after.terms.termsSalt }));
    expect((await rig.get(`/series/${seriesId}`)).json().terms.termsCommitment).toBe(after.commitment);
  });
});

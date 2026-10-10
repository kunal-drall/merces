import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { termsCommitment, type SignedTx, type UnsignedTx } from '@merces/domain';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

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
    // the opening of Stage 1's Poseidon terms commitment, with the codes the circuit takes
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
    const built = await rig.post(`/drafts/${draft.draftId}/build-create-series`, {}, issuerTok);
    expect(built.statusCode).toBe(200);
    const tx = built.json().tx as UnsignedTx;
    expect(tx.command.kind).toBe('createSeries');
    expect((tx.command as { terms: { contractHash: string; termsCommitment: string } }).terms.contractHash).toBe(signedHash);
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

    // inflation amendment: propose → attestor attests favourability → build with co-signer → send → apply
    const attestor = rig.sol.attestors[0]!;
    const attTok = rig.token({ accountId: 'att-1', roles: ['attestor'], wallets: [{ chain: 'solana', address: attestor.address }] });
    const prop = await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2026 }, issuerTok, { 'idempotency-key': 'k-amend' });
    expect(prop.statusCode).toBe(200);
    expect(prop.json().inflationBps).toBe(300);
    const amendmentId = prop.json().amendmentId as string;
    // a retried proposal with the same key replays the first one instead of creating a second amendment
    const retry = await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2026 }, issuerTok, { 'idempotency-key': 'k-amend' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(prop.json());
    expect((await rig.post(`/series/${seriesId}/amendments/inflation`, { year: 2027 }, issuerTok, { 'idempotency-key': 'k-amend' })).statusCode).toBe(409);
    expect((await rig.get(`/series/${seriesId}/amendments`, issuerTok)).json().amendments.map((a: { amendmentId: string }) => a.amendmentId)).toEqual([amendmentId]);
    expect((await rig.post(`/amendments/${amendmentId}/build`, {}, issuerTok)).statusCode).toBe(409);
    // only a wallet of the caller's, on the series' chain, that the chain has registered as an attestor may attest
    const monAtt = rig.mon.attestors[0]!;
    const wrongChain = rig.token({ accountId: 'att-2', roles: ['attestor'], wallets: [{ chain: 'monad', address: monAtt.address }] });
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, { attestorWallet: monAtt.address, approve: true }, wrongChain)).statusCode).toBe(403);
    const unreg = new SimWallet('solana', 'attestor-unregistered');
    const unregTok = rig.token({ accountId: 'att-3', roles: ['attestor'], wallets: [{ chain: 'solana', address: unreg.address }] });
    // an unregistered wallet never reaches the attestor routes, whatever role its token claims (A-M5-2)
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, { attestorWallet: unreg.address, approve: true }, unregTok)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/amendments/${amendmentId}/attest`, { attestorWallet: attestor.address, approve: true }, unregTok)).statusCode).toBe(403);
    // a registered attestor naming a wallet the chain has not registered is refused by the service
    const twoWallets = rig.token({ accountId: 'att-4', roles: ['attestor'], wallets: [{ chain: 'solana', address: attestor.address }, { chain: 'solana', address: unreg.address }] });
    const refused = await rig.post(`/attestor/amendments/${amendmentId}/attest`, { attestorWallet: unreg.address, approve: true }, twoWallets);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain('not a registered attestor');
    expect((await rig.get(`/series/${seriesId}/amendments`, issuerTok)).json().amendments[0].state).toBe('proposed');
    const att = await rig.post(`/attestor/amendments/${amendmentId}/attest`, { attestorWallet: attestor.address, approve: true }, attTok);
    expect(att.json()).toMatchObject({ state: 'attested', favourable: true });
    const b2 = await rig.post(`/amendments/${amendmentId}/build`, {}, issuerTok);
    const atx = b2.json().tx as UnsignedTx;
    expect(atx.coSigners).toEqual([attestor.address]);
    const s1 = await issuer.sign(atx);
    const s2 = await attestor.coSign(s1);
    const res = await rig.post('/tx/send', s2, issuerTok);
    expect(res.statusCode).toBe(200);
    expect(res.json().events[0].type).toBe('TermsAmended');
    await rig.sync();
    expect((await rig.post(`/amendments/${amendmentId}/apply`, {}, issuerTok)).statusCode).toBe(200);
    const after = (await rig.get(`/series/${seriesId}/terms`, bTok2)).json();
    expect(after.terms.threshold).toBe('66950000000');
    expect(after.version).toBe(2);
    expect(after.commitment).toBe(termsCommitment({ theta: '66950000000', rWad: after.terms.ratePerUnitWad, currency: 'USD', indexingRule: 'cpi-annual', termsSalt: after.terms.termsSalt }));
    expect((await rig.get(`/series/${seriesId}`)).json().terms.termsCommitment).toBe(after.commitment);
  });
});

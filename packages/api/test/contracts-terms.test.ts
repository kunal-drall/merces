import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, createLogger, logCapture } from '@merces/core';
import { dbTestsEnabled, type Pool } from '@merces/db';
import { ContractService, NON_REVEAL_CHARGE_UNSET, TermsService, applicationCreateSchema, assembleSchema, lockupOf, publicTermsSchema, tier3OpenSchema, tier3SignSchema, type ServiceContext } from '@merces/services';
import { DEFAULTS, seriesTermsViolations } from '@merces/domain';
import { BN254_FR, CURRENCY_CODES, INDEXING_RULES, termsCommitmentField } from '@merces/math';
import { buildSpec } from '../src/openapi/build.ts';
import type { Session } from '../src/index.ts';
import { makeRig } from './helpers.ts';

type Rig = Awaited<ReturnType<typeof makeRig>>;
type Q = { query: (sql: unknown, ...rest: unknown[]) => Promise<unknown> };

/**
 * A pool whose next statement matching `pattern` fails as if the connection dropped, on the pool itself and on
 * clients it hands out (so writes inside a transaction see the fault too). Fires once.
 */
function faultyPool(pool: Pool, pattern: RegExp): Pool {
  let armed = true;
  const wrap = (target: Q) => (sql: unknown, ...rest: unknown[]) => {
    const text = typeof sql === 'string' ? sql : String((sql as { text?: string }).text ?? '');
    if (armed && pattern.test(text)) {
      armed = false;
      return Promise.reject(new Error('connection terminated'));
    }
    return target.query(sql, ...rest);
  };
  const bindAll = <T extends object>(t: T, over: Record<string | symbol, unknown>) =>
    new Proxy(t, { get: (o, p) => (p in over ? over[p] : typeof (o as Record<string | symbol, unknown>)[p] === 'function' ? ((o as Record<string | symbol, (...a: unknown[]) => unknown>)[p]!).bind(o) : (o as Record<string | symbol, unknown>)[p]) });
  return bindAll(pool, {
    query: wrap(pool as unknown as Q),
    connect: async () => {
      const c = await pool.connect();
      return bindAll(c, { query: wrap(c as unknown as Q) });
    },
  }) as Pool;
}

describe('POST /applications contract matches the handler validation', () => {
  it('persona, income source kinds, country and notes carry the same constraints as the zod schema', () => {
    const spec = buildSpec() as unknown as { paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: { properties: Record<string, Record<string, unknown>> } } } } } }> };
    const props = spec.paths['/applications']!.post.requestBody.content['application/json'].schema.properties;
    const zs = z.toJSONSchema(applicationCreateSchema, { io: 'input' }) as { properties: Record<string, Record<string, unknown>> };
    expect(props.persona!.enum).toEqual(zs.properties.persona!.enum);
    expect((props.incomeSourceKinds!.items as { enum: string[] }).enum).toEqual((zs.properties.incomeSourceKinds!.items as { enum: string[] }).enum);
    expect([props.country!.minLength, props.country!.maxLength]).toEqual([zs.properties.country!.minLength, zs.properties.country!.maxLength]);
    expect(props.notes!.maxLength).toBe(zs.properties.notes!.maxLength);
  });
});

describe('report request bodies in the contract match the handler validation (S1 WP10)', () => {
  type Body = { required?: string[]; properties: Record<string, unknown>; additionalProperties?: boolean };
  const spec = buildSpec() as unknown as { paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: Body } } } } }> };
  const body = (path: string) => spec.paths[path]!.post.requestBody.content['application/json'].schema;
  const zodBody = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Body;
  for (const [path, schema] of [['/series/{seriesId}/reports', assembleSchema], ['/attestor/tier3/{caseId}/sign', tier3SignSchema], ['/series/{seriesId}/tier3/{periodId}', tier3OpenSchema]] as const) {
    it(`${path}: same fields, same required fields, unknown fields refused`, () => {
      const b = body(path);
      const zs = zodBody(schema);
      expect(Object.keys(b.properties).sort()).toEqual(Object.keys(zs.properties).sort());
      expect([...(b.required ?? [])].sort()).toEqual([...(zs.required ?? [])].sort());
      expect(b.additionalProperties).toBe(false);
      expect(zs.additionalProperties).toBe(false);
    });
  }
});

describe.skipIf(!dbTestsEnabled())('contract templates, contract signing and draft linking write atomically', () => {
  let rig: Rig;
  let adminTok: string;
  const issuer: Session = { accountId: 'iss-atomic', wallets: [{ chain: 'solana', address: 'iss-atomic-wallet' }], roles: ['issuer'], eligible: true, exp: 0, iat: 0 };
  const withPool = (pool: Pool): ServiceContext => ({ ...rig.ctx, pool }) as ServiceContext;
  const draftRow = async (draftId: string, state: string, extra: { contractHash?: string; commitment?: string } = {}) =>
    rig.t.pool.query('insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, state, contract_hash, terms_commitment) values ($1,$2,$3,$4,$5,$6,$7,$8)', [draftId, issuer.accountId, 'solana', 'iss-atomic-wallet', '{}', state, extra.contractHash ?? null, extra.commitment ?? null]);

  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('retries a timed-out real envelope with the same persisted session and refuses unsigned callbacks', async () => {
    await draftRow('draft-provider-retry', 'terms_set');
    const calls: string[] = [];
    const provider = {
      provider: 'docusign-demo',
      createEnvelope: async (params: { sessionId: string }) => {
        calls.push(params.sessionId);
        if (calls.length === 1) throw Error('provider-connection-failed');
        return { envelopeId: 'vendor-envelope', signingUrl: 'https://demo.docusign.net/signing/test' };
      },
      status: async () => 'sent' as const,
      signedDocument: async () => null,
    };
    const context = { ...rig.ctx, esign: provider };
    const service = new ContractService(context);
    await expect(service.prepare('draft-provider-retry', issuer)).rejects.toThrow('provider-connection-failed');
    expect((await rig.t.pool.query("select state from contract_sessions where draft_id='draft-provider-retry'")).rows[0].state).toBe('prepared');
    await service.prepare('draft-provider-retry', issuer);
    expect(calls).toHaveLength(2); expect(calls[0]).toBe(calls[1]);
    expect((await rig.t.pool.query("select count(*)::int as n from contract_sessions where draft_id='draft-provider-retry'")).rows[0].n).toBe(1);
    const original = rig.ctx.esign; rig.ctx.esign = provider;
    try { expect((await rig.post('/contracts/webhook/docusign-demo', { sessionId: calls[0] })).statusCode).toBe(403); }
    finally { rig.ctx.esign = original; }
  });

  it('re-adding an existing template version is a 409 and keeps the original body', async () => {
    const first = await rig.post('/admin/contracts/templates', { kind: 'heu', version: 'v9', body: 'x' }, adminTok);
    expect(first.statusCode).toBe(200);
    const again = await rig.post('/admin/contracts/templates', { kind: 'heu', version: 'v9', body: 'y' }, adminTok);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('Conflict');
    expect((await rig.t.pool.query("select body from contract_templates where template_id = 'heu-v9'")).rows[0].body).toBe('x');
  });

  it('contract refresh: a fault after the session update rolls everything back, and a retry signs the draft with one notification', async () => {
    await draftRow('draft-cs', 'terms_set');
    const env = await rig.esign.createEnvelope({ sessionId: 'cs-atomic', signerAccountId: issuer.accountId, documents: [{ name: 'HEU Contract', body: 'b' }] });
    await rig.t.pool.query("insert into contract_sessions (session_id, account_id, chain, issuer, draft_id, provider, provider_ref, state, heu_template_id, charter_template_id, rendered_hash) values ('cs-atomic',$1,'solana','iss-atomic-wallet','draft-cs',$2,$3,'sent','h','c','00')", [issuer.accountId, rig.esign.provider, env.envelopeId]);
    await rig.esign.complete(env.envelopeId);

    await expect(new ContractService(withPool(faultyPool(rig.t.pool, /update series_drafts set state = 'contract_signed'/))).refresh('cs-atomic')).rejects.toThrow('connection terminated');
    expect((await rig.t.pool.query("select state, signed_hash from contract_sessions where session_id = 'cs-atomic'")).rows[0]).toEqual({ state: 'sent', signed_hash: null });
    expect((await rig.t.pool.query("select state from series_drafts where draft_id = 'draft-cs'")).rows[0].state).toBe('terms_set');

    const s = new ContractService(rig.ctx);
    const done = await s.refresh('cs-atomic');
    expect(done.state).toBe('signed');
    const d = (await rig.t.pool.query("select state, contract_hash from series_drafts where draft_id = 'draft-cs'")).rows[0];
    expect(d).toEqual({ state: 'contract_signed', contract_hash: done.signedHash });
    await s.refresh('cs-atomic');
    const notes = await rig.t.pool.query("select count(*)::int as n from outbox where payload->>'kind' = 'contract.signed' and payload->>'draftId' = 'draft-cs'");
    expect(notes.rows[0].n).toBe(1);
  });

  it('link-created: a fault on the vault update leaves the draft unlinked; a draft left linked without its vault is repaired on retry', async () => {
    await draftRow('draft-link', 'contract_signed', { contractHash: '0xaa', commitment: '0xbb' });
    await rig.t.pool.query("insert into terms_vault (draft_id, ciphertext, key_id, commitment) values ('draft-link', 'ct', 'k', '0xbb')");
    const terms = new TermsService(withPool(faultyPool(rig.t.pool, /update terms_vault set series_id/)));
    const markCreated = (svc: TermsService) => (svc as unknown as { markCreated(d: string, s: string, sess: Session): Promise<unknown> }).markCreated('draft-link', 'solana:linked', issuer);
    await expect(markCreated(terms)).rejects.toThrow('connection terminated');
    expect((await rig.t.pool.query("select state, series_id from series_drafts where draft_id = 'draft-link'")).rows[0]).toEqual({ state: 'contract_signed', series_id: null });

    // the state an earlier non-atomic write could leave behind: draft linked, vault not
    await rig.t.pool.query("update series_drafts set state = 'created', series_id = 'solana:linked' where draft_id = 'draft-link'");
    const r = await new TermsService(rig.ctx).linkCreated('draft-link', issuer);
    expect(r.seriesId).toBe('solana:linked');
    expect((await rig.t.pool.query("select series_id from terms_vault where draft_id = 'draft-link'")).rows[0].series_id).toBe('solana:linked');
  });

  it('set terms: a fault on the vault write leaves the draft without the new commitment', async () => {
    await draftRow('draft-terms', 'draft');
    const pub = { stablecoin: 'USDC' as const, unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', lockupSeconds: 0, releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], hurdle: '0.05', payoutMultipleK: 2, tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', raiseStyle: 'sealed' as const, country: 'US' };
    const priv = { threshold: '65000000000', shareRate: '0.10', indexingRule: 'cpi-annual' as const };
    const terms = new TermsService(withPool(faultyPool(rig.t.pool, /insert into terms_vault/)));
    await expect(terms.setTerms('draft-terms', issuer, pub, priv)).rejects.toThrow('connection terminated');
    expect((await rig.t.pool.query("select state, terms_commitment from series_drafts where draft_id = 'draft-terms'")).rows[0]).toEqual({ state: 'draft', terms_commitment: null });
    const ok = await new TermsService(rig.ctx).setTerms('draft-terms', issuer, pub, priv);
    expect((await rig.t.pool.query("select commitment from terms_vault where draft_id = 'draft-terms'")).rows[0].commitment).toBe(ok.termsCommitment);
    // the scheme is Stage 1's (cause PF: was SHA-256 over canonical JSON with a hex salt): the vault holds the opening
    // of Poseidon(5)(θ, r, ISO-4217 numeric currency, indexing rule code, field salt), and Stage 1's own function over
    // that opening gives the stored commitment
    const vault = (await rig.t.pool.query("select ciphertext from terms_vault where draft_id = 'draft-terms'")).rows[0].ciphertext as string;
    const opening = JSON.parse(rig.ctx.vault.decrypt(vault, 'terms:draft-terms')) as Record<string, string | number>;
    // r = 10% / 1,000 units offered = 1e14 WAD per unit
    expect(opening).toMatchObject({ scheme: 'poseidon5-v1', threshold: '65000000000', ratePerUnitWad: '100000000000000', reportingCurrency: 'USD', currencyCode: CURRENCY_CODES.USD, indexingRule: 'cpi-annual', indexingRuleCode: INDEXING_RULES.cpiYearly });
    expect(BigInt(opening.termsSalt!)).toBeLessThan(BN254_FR);
    const stage1 = termsCommitmentField({ theta: 65_000_000_000n, rWad: 100_000_000_000_000n, currencyCode: CURRENCY_CODES.USD, indexingRule: INDEXING_RULES.cpiYearly, termsSalt: BigInt(opening.termsSalt!) });
    expect(ok.termsCommitment).toBe('0x' + stage1.toString(16).padStart(64, '0'));
    // anyone recomputes it from the disclosed opening (POST /terms/commitment)
    expect((await rig.post('/terms/commitment', opening)).json()).toEqual({ commitment: ok.termsCommitment, scheme: 'poseidon5-v1' });
  });

  it('a reporting currency outside Stage 1\'s terms commitment is refused when the terms are set (S1 WP12)', async () => {
    await draftRow('draft-nzd', 'draft');
    const pub = { stablecoin: 'USDC' as const, unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', lockupSeconds: 0, releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], hurdle: '0.05', payoutMultipleK: 2, tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'NZD', raiseStyle: 'sealed' as const, country: 'US' };
    // NZD has no ISO-4217 numeric code in Stage 1's CURRENCY_CODES, so no Poseidon commitment can carry it (cause PF:
    // was accepted, the SHA-256 commitment took any currency string)
    expect(Object.keys(CURRENCY_CODES)).not.toContain('NZD');
    await expect(new TermsService(rig.ctx).setTerms('draft-nzd', issuer, pub, { threshold: '65000000000', shareRate: '0.10', indexingRule: 'cpi-annual' })).rejects.toMatchObject({ status: 422, detail: { issues: expect.arrayContaining([expect.objectContaining({ field: 'reportingCurrency', code: 'unsupported' })]) } });
    expect((await rig.t.pool.query("select state, terms_commitment from series_drafts where draft_id = 'draft-nzd'")).rows[0]).toEqual({ state: 'draft', terms_commitment: null });
    expect((await rig.t.pool.query("select count(*)::int as n from terms_vault where draft_id = 'draft-nzd'")).rows[0].n).toBe(0);
    // and the public recompute endpoint refuses it the same way
    expect((await rig.post('/terms/commitment', { threshold: '65000000000', ratePerUnitWad: '100000000000000', reportingCurrency: 'NZD', indexingRule: 'cpi-annual', termsSalt: '1' })).statusCode).toBe(422);
  });

  // Stage 1's create_series rules (SIM:756-781) on a draft, per field and value-free, so terms Stage 1 would refuse never
  // reach buildCreateSeries (review finding: validate() bounded only the cap, the bps sum, units, reserve and min raise)
  it('terms validation applies Stage 1\'s create_series bounds per field, with messages that carry no submitted value', async () => {
    const svc = new TermsService(rig.ctx);
    const YEAR = 365 * 86_400;
    const pub = { stablecoin: 'USDC' as const, unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', lockupSeconds: 0, releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], hurdle: '0.05', payoutMultipleK: 2, tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', raiseStyle: 'sealed' as const, country: 'US' };
    const bad = { ...pub, hurdle: '0.5', payoutMultipleK: 30, lockupSeconds: 6 * YEAR, releaseSchedule: [{ afterSeconds: 90 * 86_400, bps: 5000 }, { afterSeconds: 0, bps: 5000 }], unitsOffered: '5', minimumRaise: '0' };
    const { issues } = await svc.validate('solana', bad, null, 2026);
    expect(issues.map((i) => [i.field, i.code])).toEqual([
      ['hurdle', 'out-of-bounds'],
      ['payoutMultipleK', 'out-of-bounds'],
      ['lockupSeconds', 'out-of-bounds'],
      ['unitsOffered', 'wallet-cap-below-one-unit'], // floor(5 × 10% default wallet cap) = 0
      ['releaseSchedule', 'offsets-decrease'],
    ]);
    expect(issues.find((i) => i.field === 'hurdle')!.message).toBe('hurdle rate must be between 0 and 0.25');
    for (const i of issues) expect(i.message, i.field).not.toMatch(/0\.5\b|\b30\b|189216000|7776000/);
    // too many tranches and an unreachable minimum raise
    const more = await svc.validate('solana', { ...pub, minimumRaise: '8000000001', releaseSchedule: Array.from({ length: 25 }, (_, i) => ({ afterSeconds: i, bps: 400 })) }, null, 2026);
    expect(more.issues.map((i) => [i.field, i.code])).toEqual([['minimumRaise', 'unreachable'], ['releaseSchedule', 'too-many-tranches']]);
    // the bounds themselves are valid
    const atBounds = await svc.validate('solana', { ...pub, hurdle: '0.25', payoutMultipleK: 20, lockupSeconds: 5 * YEAR, capMultiple: '3' }, null, 2026);
    expect(atBounds.issues).toEqual([]);
    // setTerms refuses the draft and stores nothing
    await draftRow('draft-bounds', 'draft');
    await expect(svc.setTerms('draft-bounds', issuer, bad, { threshold: '65000000000', shareRate: '0.10', indexingRule: 'cpi-annual' })).rejects.toMatchObject({ status: 422, detail: { issues: expect.arrayContaining([expect.objectContaining({ field: 'hurdle', code: 'out-of-bounds' })]) } });
    expect((await rig.t.pool.query("select state, terms_commitment from series_drafts where draft_id = 'draft-bounds'")).rows[0]).toEqual({ state: 'draft', terms_commitment: null });
  });

  // cause S3-CT (Stage 1 registry create_series, lib.rs:462-572) and S3-NC: a curve draft is checked with Stage 1's
  // curve rules, and the createSeries it builds carries Stage 1's zeros: no lockup, no wallet cap, no raise phases
  it('a curve draft takes Stage 1\'s curve rules; buildCreateSeries sends no lockup, no wallet cap and no raise phases', async () => {
    const svc = new TermsService(rig.ctx);
    const curve = { stablecoin: 'USDC' as 'USDC' | 'USDG', unitsOffered: '1000', reservePrice: '5000000', minimumRaise: '2000000000', capMultiple: '2.5', releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], hurdle: '0.05', payoutMultipleK: 2, tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', raiseStyle: 'curve' as const, country: 'US' };
    // the lockup defaults by raise style: 0 on a curve raise (Stage 1 requires it), Stage 1's 18 months on a sealed one
    expect(lockupOf(curve)).toBe(0);
    expect(lockupOf({ raiseStyle: 'sealed' })).toBe(DEFAULTS.lockupSeconds);
    const issues = async (over: Partial<typeof curve> & { lockupSeconds?: number }) => (await svc.validate('solana', { ...curve, ...over }, null, 2026)).issues.map((i) => [i.field, i.code, i.message]);
    expect(await issues({})).toEqual([]);
    expect(await issues({ lockupSeconds: 86_400 })).toEqual([['lockupSeconds', 'curve-zero', 'lockup must be 0 on a curve series']]);
    expect(await issues({ stablecoin: 'USDG' })).toEqual([['stablecoin', 'curve-quote-usdc', 'a curve raise is quoted in USDC']]);
    expect(await issues({ minimumRaise: '0' })).toEqual([['minimumRaise', 'positive', 'minimum raise (the curve\'s migration threshold) must be positive']]);
    // the minimum raise is the curve's target: above reserve × units is fine (a sealed raise refuses it as unreachable)
    expect(await issues({ minimumRaise: '8000000000' })).toEqual([]);
    expect((await svc.validate('solana', { ...curve, raiseStyle: 'sealed', minimumRaise: '8000000000' }, null, 2026)).issues.map((i) => i.code)).toEqual(['unreachable']);
    // the draft, through to the createSeries it builds
    const wallet = rig.sol.issuer.address;
    await rig.t.pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, state) values ('draft-curve', $1, 'solana', $2, '{}', 'draft')", [issuer.accountId, wallet]);
    await svc.setTerms('draft-curve', issuer, curve, { threshold: '65000000000', shareRate: '0.10', indexingRule: 'cpi-annual' });
    expect((await rig.t.pool.query("select public_terms from series_drafts where draft_id = 'draft-curve'")).rows[0].public_terms).toMatchObject({ raiseStyle: 'curve', lockupSeconds: 0 });
    await rig.t.pool.query("update series_drafts set state = 'contract_signed', contract_hash = $2 where draft_id = $1", ['draft-curve', '0x' + 'cc'.repeat(32)]);
    const built = await svc.buildCreateSeries('draft-curve', issuer);
    expect(built.terms).toMatchObject({ raiseStyle: 'curve', stablecoin: 'USDC', lockupSeconds: 0, walletCapBps: 0, commitDurationSeconds: 0, revealDurationSeconds: 0, auctionFeeBps: DEFAULTS.auctionFeeBps, payoutFeeBps: DEFAULTS.payoutFeeBps });
    expect(seriesTermsViolations(built.terms)).toEqual([]);
    // a sealed draft keeps the auction's terms
    await rig.t.pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, state) values ('draft-sealed', $1, 'solana', $2, '{}', 'draft')", [issuer.accountId, wallet]);
    await svc.setTerms('draft-sealed', issuer, { ...curve, raiseStyle: 'sealed', minimumRaise: '4000000000' }, { threshold: '65000000000', shareRate: '0.10', indexingRule: 'cpi-annual' });
    await rig.t.pool.query("update series_drafts set state = 'contract_signed', contract_hash = $2 where draft_id = $1", ['draft-sealed', '0x' + 'cd'.repeat(32)]);
    expect((await svc.buildCreateSeries('draft-sealed', issuer)).terms).toMatchObject({ lockupSeconds: DEFAULTS.lockupSeconds, walletCapBps: DEFAULTS.walletCapBps, commitDurationSeconds: DEFAULTS.commitDurationSeconds, revealDurationSeconds: DEFAULTS.revealDurationSeconds });
    // cause NRC: both record the owner's non-reveal charge (the rig sets 100 bps), as Stage 1's chains copy the protocol
    // default into every series, a curve's included (lib.rs:550); the issuer's draft has no say in it
    expect([built.terms.nonRevealChargeBps, (await svc.buildCreateSeries('draft-sealed', issuer)).terms.nonRevealChargeBps]).toEqual([100, 100]);
    expect('nonRevealChargeBps' in publicTermsSchema.shape).toBe(false);
    // unset: a sealed raise is refused (409, naming the setting); a curve, which has no bids to charge, records 0; a draft
    // is still checked on every other rule
    const owner = rig.ctx.nonRevealChargeBps;
    rig.ctx.nonRevealChargeBps = null;
    try {
      const refused = await svc.buildCreateSeries('draft-sealed', issuer).then(() => null, (e: unknown) => e as AppError);
      expect([refused?.status, refused?.detail]).toEqual([409, { setting: 'MERCES_NON_REVEAL_CHARGE_BPS' }]);
      expect(refused?.message).toBe(NON_REVEAL_CHARGE_UNSET);
      expect((await svc.buildCreateSeries('draft-curve', issuer)).terms.nonRevealChargeBps).toBe(0);
      expect(await issues({})).toEqual([]);
      expect((await svc.validate('solana', { ...curve, raiseStyle: 'sealed', minimumRaise: '4000000000' }, null, 2026)).issues).toEqual([]);
    } finally {
      rig.ctx.nonRevealChargeBps = owner;
    }
  });

  // S1 review: a share rate with more than 18 places made wadFromDecimal throw a RangeError carrying the value, which
  // the API answered with a 500 and wrote, value included, to the operator log. The share rate is a private term (it
  // sets r): it is now refused by the schema with a message naming the rule, and wadFromDecimal's errors carry no value.
  it('a share rate with more than 18 places is a 400 naming the rule; the value reaches no log line, error or response', async () => {
    const SHARE_19 = '0.0642642642642642642';
    const pub = { stablecoin: 'USDC' as const, unitsOffered: '1000', reservePrice: '8000000', minimumRaise: '4000000000', capMultiple: '2.5', lockupSeconds: 0, releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], hurdle: '0.05', payoutMultipleK: 2, tierFlags: { tier1: false, tier2: true, tier3: false, tier4: false }, reportingCurrency: 'USD', raiseStyle: 'sealed' as const, country: 'US' };
    const tok = rig.token({ accountId: issuer.accountId, wallets: issuer.wallets, roles: ['issuer'] });
    const silent = rig.ctx.log;
    logCapture.enabled = true;
    logCapture.silent = true;
    logCapture.reset();
    // the production logger and redaction, so an unhandled error would be captured exactly as it would reach stdout
    (rig.ctx as { log: unknown }).log = createLogger('terms-probe', 'debug');
    try {
      const rule = expect.objectContaining({ path: ['private', 'shareRate'], message: 'a decimal between 0 and 1 with at most 18 places' });
      const validate = await rig.post('/terms/validate', { chain: 'solana', public: pub, private: { threshold: '65000000000', shareRate: SHARE_19 } }, tok);
      expect(validate.statusCode, validate.body).toBe(400);
      expect(validate.json().detail.issues).toEqual([rule]);
      await draftRow('draft-share', 'draft');
      const set = await rig.put('/drafts/draft-share/terms', { public: pub, private: { threshold: '65000000000', shareRate: SHARE_19 } }, tok);
      expect(set.statusCode, set.body).toBe(400);
      expect(set.json().detail.issues).toEqual([rule]);
      expect((await rig.t.pool.query("select count(*)::int as n from terms_vault where draft_id = 'draft-share'")).rows[0].n).toBe(0);
      // a caller that skips the schema gets a field issue, not a thrown error
      const direct = await new TermsService(rig.ctx).validate('solana', pub, { threshold: '65000000000', shareRate: SHARE_19, indexingRule: 'cpi-annual' }, 2026);
      expect(direct.issues).toContainEqual({ field: 'shareRate', code: 'format', message: 'share rate must be a decimal between 0 and 1 with at most 18 places' });
      expect(direct.derived.ratePerUnitWad).toBeNull();
      // the capture saw nothing: no unhandled error was logged
      expect(logCapture.lines).toEqual([]);
      for (const out of [validate.body, set.body, JSON.stringify(direct)]) expect(out).not.toContain('642642642');
      // 18 places are the most a WAD holds, and are accepted; so are a cap multiple and a hurdle with 18 places, while 19 are refused
      const ok = await rig.post('/terms/validate', { chain: 'solana', public: { ...pub, capMultiple: '2.500000000000000000', hurdle: '0.050000000000000000' }, private: { threshold: '65000000000', shareRate: '0.064264264264264264' } }, tok);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().derived).toMatchObject({ ratePerUnitWad: (64_264_264_264_264_264n / 1000n).toString(), capMultipleWad: (25n * 10n ** 17n).toString(), hurdleWad: (5n * 10n ** 16n).toString() });
      for (const field of ['capMultiple', 'hurdle']) {
        const r = await rig.post('/terms/validate', { chain: 'solana', public: { ...pub, [field]: '0.0500000000000000001' }, private: null }, tok);
        expect(r.statusCode, field).toBe(400);
        expect(r.json().detail.issues).toEqual([expect.objectContaining({ path: ['public', field], message: 'a decimal with at most 18 places' })]);
      }
      expect(logCapture.lines).toEqual([]);
    } finally {
      (rig.ctx as { log: unknown }).log = silent;
      logCapture.enabled = false;
      logCapture.silent = false;
      logCapture.reset();
    }
  });

  it('a draft whose vault payload predates the Poseidon terms scheme is refused at submission (S1 WP10; cause PF)', async () => {
    await draftRow('draft-legacy', 'contract_signed', { contractHash: '0x' + 'aa'.repeat(32), commitment: '0x' + 'bb'.repeat(32) });
    // a SHA-256-era payload: no scheme, a hex salt
    const ct = rig.ctx.vault.encrypt(JSON.stringify({ threshold: '65000000000', shareRate: '0.10', ratePerUnitWad: '100000000000000', reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x' + '22'.repeat(32) }), 'terms:draft-legacy');
    await rig.t.pool.query("insert into terms_vault (draft_id, ciphertext, key_id, commitment) values ('draft-legacy', $1, $2, $3)", [ct, rig.ctx.vault.keyId, '0x' + 'bb'.repeat(32)]);
    await expect(new TermsService(rig.ctx).buildCreateSeries('draft-legacy', issuer)).rejects.toThrow(/predate the poseidon5-v1 commitment scheme/);
  });
});

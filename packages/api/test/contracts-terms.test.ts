import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dbTestsEnabled, type Pool } from '@merces/db';
import { ContractService, TermsService, applicationCreateSchema, assembleSchema, tier3OpenSchema, tier3SignSchema, type ServiceContext } from '@merces/services';
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

  it('a draft whose vault payload predates the Poseidon terms scheme is refused at submission (S1 WP10; cause PF)', async () => {
    await draftRow('draft-legacy', 'contract_signed', { contractHash: '0x' + 'aa'.repeat(32), commitment: '0x' + 'bb'.repeat(32) });
    // a SHA-256-era payload: no scheme, a hex salt
    const ct = rig.ctx.vault.encrypt(JSON.stringify({ threshold: '65000000000', shareRate: '0.10', ratePerUnitWad: '100000000000000', reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x' + '22'.repeat(32) }), 'terms:draft-legacy');
    await rig.t.pool.query("insert into terms_vault (draft_id, ciphertext, key_id, commitment) values ('draft-legacy', $1, $2, $3)", [ct, rig.ctx.vault.keyId, '0x' + 'bb'.repeat(32)]);
    await expect(new TermsService(rig.ctx).buildCreateSeries('draft-legacy', issuer)).rejects.toThrow(/predate the poseidon5-v1 commitment scheme/);
  });
});

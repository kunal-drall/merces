import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { loadSpecOps } from '@merces/server';
import { makeRig } from '../../api/test/helpers.ts';

/**
 * H3 access matrix, endpoint by endpoint, from the assembled OpenAPI contract:
 *  - every non-public operation refuses an anonymous call (401)
 *  - admin/attestor operations refuse a plain backer (403)
 *  - holder/issuer operations on a series refuse a signed-in stranger (403)
 *  - backer-tier operations refuse an ineligible account (403)
 *  - public operations never return 401/403
 *
 * S4 cause codes:
 *  - S4-CTX: the public read of Stage 1's signing context (`GET /series/{seriesId}/signing`: the domain, the series key
 *    and the nonces) names "signing" in its path; it is listed by method and path, and checked to be a public GET whose
 *    response carries no signature;
 *  - S4-ID: the attestor key routes (S4 WP7: the public registry read and the account's key links) name "signer" in
 *    their paths; they are listed by method, path and tier, and the link takes the key's own proof (the server signs
 *    nothing and holds no key).
 */
describe.skipIf(!dbTestsEnabled())('access-tier matrix (H3)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let seriesId: string;
  const ids: Record<string, string> = { applicationId: 'app_x', draftId: 'draft_x', reportId: 'rep_x', amendmentId: 'amend_x', provider: 'mock', country: 'US', periodId: '2026Q1', issuerId: 'solana:none', bidder: 'none', chain: 'solana', wallet: 'none', name: 'tier4', id: 'x', requestId: 'x', notificationId: 'x', year: '2026', sampleId: 'x' };
  beforeAll(async () => {
    rig = await makeRig();
    seriesId = (await rig.sol.runRaise()).seriesId;
    await rig.sync();
  });
  afterAll(async () => {
    await rig.close();
  });

  const fill = (p: string) => p.replace(/\{(\w+)\}/g, (_m, k: string) => (k === 'seriesId' ? seriesId : ids[k] ?? 'x'));
  const call = (method: string, path: string, tok?: string) => rig.app.inject({ method: method as 'GET', url: fill(path), headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload: ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined });

  it('every operation enforces its declared tier', async () => {
    const { ops } = loadSpecOps();
    const backer = rig.token({ accountId: 'stranger', roles: ['backer'], eligible: true, wallets: [{ chain: 'solana', address: 'strangerwallet' }] });
    const ineligible = rig.token({ accountId: 'inel', roles: ['backer'], eligible: false, wallets: [] });
    const problems: string[] = [];
    for (const op of ops) {
      if (op.devOnly) continue;
      const anon = await call(op.method, op.path);
      if (op.access === 'public') {
        if ([401, 403].includes(anon.statusCode)) problems.push(`${op.method} ${op.path}: public but ${anon.statusCode}`);
        continue;
      }
      if (anon.statusCode !== 401) problems.push(`${op.method} ${op.path}: anonymous got ${anon.statusCode}, expected 401`);
      if (['admin', 'attestor'].includes(op.access)) {
        const r = await call(op.method, op.path, backer);
        if (r.statusCode !== 403) problems.push(`${op.method} ${op.path}: backer got ${r.statusCode}, expected 403 (${op.access})`);
      }
      if (['holder', 'issuer', 'holder-or-issuer', 'issuer-or-attestor'].includes(op.access) && op.path.includes('{seriesId}')) {
        const r = await call(op.method, op.path, backer);
        if (r.statusCode !== 403) problems.push(`${op.method} ${op.path}: stranger got ${r.statusCode}, expected 403 (${op.access})`);
      }
      if (op.access === 'backer') {
        const r = await call(op.method, op.path, ineligible);
        if (r.statusCode !== 403) problems.push(`${op.method} ${op.path}: ineligible got ${r.statusCode}, expected 403`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
    expect(ops.length).toBeGreaterThan(80);
  });

  it('no operation lets the backend sign for a user or move funds: every chain write is an unsigned transaction', async () => {
    const { spec } = loadSpecOps();
    const text = JSON.stringify(spec);
    expect(text).not.toMatch(/privateKey|secretKey|seedPhrase/i);
    // the only signed thing accepted is the user's own signed tx relay
    // cause S4-CTX: the signing-context read is not a signing operation (a public GET returning public onchain values)
    const contextReads = new Set(['GET /series/{seriesId}/signing']);
    const all = loadSpecOps().ops;
    for (const k of contextReads) {
      const op = all.find((o) => `${o.method} ${o.path}` === k);
      expect(op, k).toMatchObject({ method: 'GET', access: 'public' });
    }
    const schemas = (spec as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } }).components.schemas;
    expect(JSON.stringify((spec as { paths: Record<string, unknown> }).paths['/series/{seriesId}/signing'])).toContain('#/components/schemas/SeriesSigningContext');
    expect(Object.keys(schemas.SeriesSigningContext!.properties!).sort()).toEqual(['chain', 'domain', 'nonces', 'seriesId', 'seriesKey']);
    // cause S4-ID: the attestor key routes sign nothing either (S4 WP7): the public registry read returns public onchain
    // values, and the link routes take the key's own EIP-191 proof from the account (the server only verifies it; it
    // never holds or asks for a key)
    const keyRoutes = new Map([
      ['GET /chains/{chain}/signer-keys', 'public'],
      ['POST /me/signer-keys/challenge', 'account'],
      ['POST /me/signer-keys', 'account'],
      ['GET /me/signer-keys', 'account'],
      ['DELETE /me/signer-keys/{address}', 'account'],
      // S4 recovery only readdresses offchain work after a live registry rotation; it never signs or sends a tx.
      ['POST /me/signer-keys/readdress-work', 'account'],
    ]);
    for (const [k, access] of keyRoutes) expect(all.find((o) => `${o.method} ${o.path}` === k), k).toMatchObject({ access });
    expect(JSON.stringify((spec as { paths: Record<string, Record<string, unknown>> }).paths['/me/signer-keys']!.post)).toMatch(/"required":\["address","nonce","signature"\]/);
    const ops = all.filter((o) => /sign/i.test(o.path) && !/esign|contract|signed|sign-in|session/i.test(o.path) && !contextReads.has(`${o.method} ${o.path}`) && !keyRoutes.has(`${o.method} ${o.path}`));
    expect(ops.map((o) => o.path).filter((p) => !p.endsWith('/sign'))).toEqual([]);
  });
});

import { createTestSchema } from '@merces/db';
import type { ChainRegistry } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import { buildApp, issueSession, makeContext, type Session } from '../src/index.ts';
import { createServiceContext, serviceRoutes } from '@merces/services';
import { Groth16ReportVerifier, LocalKms, MockESign, MockIdentityCheck, MockZkTls, reportProofVerifier, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier, verifierChainsFromPorts } from '@merces/report-verifier';

const GENESIS = Date.UTC(2026, 0, 1) / 1000;
export const SECRET = 'test-secret';

/*
 * S4 cause codes:
 *  - S4-KMS: a local KMS key id names its algorithm explicitly (S4 WP3);
 *  - S4-T2: the verifier keys are secp256k1, registered by address, and the in-process verifier's chain table is each
 *    simulator's own signing domain (S4 WP6, amendment D10);
 *  - S4-ID: attestors are keys linked to an account (S4 WP7): attestor access is read live from the account's linked
 *    keys (`account_signer_keys`) and the indexed registry, never from a token's wallets or roles; `linkKeys` and
 *    `attestorToken` link published simulator test keys directly (the link route's EIP-191 proof is tested in
 *    signer-keys.test.ts);
 *  - S4-FX: the FX fallback is Stage 1's FX signature per series, stored through the attestor routes (S4 WP9);
 *    `signFxFallback` signs a period's rate for every covered series as the attestor's device would.
 */

/** Test rig: one schema, two simulator harnesses, an indexer and the app with every route registered. */
export async function makeRig(opts: { genesis?: number; keyPrefix?: string; extraRoutes?: ((app: import('fastify').FastifyInstance, ctx: import('@merces/api').AppContext) => void)[] } = {}) {
  const t = await createTestSchema();
  const prefix = opts.keyPrefix ?? `t${Math.random().toString(36).slice(2, 7)}`;
  // the chains verify Stage 1 Groth16 proofs (the device's) like the API's; the tests also opt into mock proofs, which
  // the harness builds for speed (H3: never the default)
  const groth16 = new Groth16ReportVerifier();
  const sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: `solana`, genesis: opts.genesis ?? GENESIS, acceptMockProofs: true, reportProofVerifier: groth16 }) });
  const mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: `monad`, genesis: opts.genesis ?? GENESIS, acceptMockProofs: true, reportProofVerifier: groth16 }) });
  void prefix;
  const chains: ChainRegistry = {
    chains: new Map([[sol.sim.chain, sol.sim], [mon.sim.chain, mon.sim]]),
    decisions: [],
    stage1: null,
    // throws on an unknown key, like the production registry, so tests see the real error path
    get: (c) => {
      if (c === sol.sim.chain) return sol.sim;
      if (c === mon.sim.chain) return mon.sim;
      throw new Error(`unknown chain ${c}`);
    },
    byFamily: (f) => (f === 'solana' ? sol.sim : mon.sim),
    close: async () => undefined,
  };
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
  const indexer = new Indexer(t.pool, [sol.sim, mon.sim], { logger: silent });
  const esign = new MockESign();
  const identity = new MockIdentityCheck();
  const zktls = new MockZkTls();
  // cause S4-KMS: each local key id names its algorithm; cause S4-T2: the verifier keys are secp256k1, registered by
  // address, and the verifier's chain table is each simulator's own signing domain (S4 amendment D10)
  const kms = new LocalKms('test-seed', { 'report-verifier-test': 'secp256k1', 'second-verifier': 'secp256k1' });
  const verifier = new ReportVerifier(zktls, kms, { keyId: 'report-verifier-test', chains: () => verifierChainsFromPorts([sol.sim, mon.sim]), allowLocal: true });
  for (const h of [sol, mon]) await h.exec(h.admin, { kind: 'registerVerifierKey', key: await kms.signerAddress('report-verifier-test') });
  const ctx = createServiceContext(makeContext({ pool: t.pool, chains, log: silent, sessionSecret: SECRET, devMode: true }), { esign, identity, zktls, kms, verifier, reportVerifierUrl: 'http://verifier.test', proofVerifier: reportProofVerifier({ acceptMock: true, groth16 }), nonRevealChargeBps: 100 });
  const app = await buildApp(ctx, [...serviceRoutes, ...(opts.extraRoutes ?? [])]);
  await app.ready();
  const token = (s: Partial<Session> & { wallets?: Session['wallets'] }) =>
    issueSession(SECRET, { accountId: s.accountId ?? 'acct', wallets: s.wallets ?? [], roles: s.roles ?? [], eligible: s.eligible ?? true, exp: Math.floor(Date.now() / 1000) + 3600 });
  /**
   * cause S4-ID: link attestor keys (published simulator test keys, 20-byte addresses) to `accountId`, creating the
   * account if needed. A key belongs to one account: linking one already linked elsewhere is a test bug and throws.
   */
  const linkKeys = async (accountId: string, keys: (string | { address: string })[]): Promise<void> => {
    await t.pool.query('insert into accounts (account_id) values ($1) on conflict (account_id) do nothing', [accountId]);
    for (const k of keys) {
      const address = typeof k === 'string' ? k : k.address;
      await t.pool.query('insert into account_signer_keys (address, account_id) values ($1, $2) on conflict (address) do nothing', [address, accountId]);
      const owner = (await t.pool.query<{ account_id: string }>('select account_id from account_signer_keys where address = $1', [address])).rows[0]?.account_id;
      if (owner !== accountId) throw new Error(`test rig: key ${address} is linked to ${owner}, not ${accountId}`);
    }
  };
  /** cause S4-ID: link `keys` to `accountId` and return its token (the role in a token is informational only). */
  const attestorToken = async (accountId: string, keys: (string | { address: string })[], s: Partial<Session> = {}): Promise<string> => {
    await linkKeys(accountId, keys);
    return token({ accountId, roles: ['attestor'], ...s });
  };
  /**
   * cause S4-FX: an FX fallback signed through the API (S4 WP9, D14). Opens the keeper's request for (chain, pair, period)
   * when there is none, then attestor key `key` (linked to its account, or to a new one) fetches the signing requests and
   * signs Stage 1's FX message for every covered series over each request's typed fields, as its device would. Returns
   * the sign route's body.
   */
  const signFxFallback = async (h: SimHarness, pair: string, periodId: string, key: { address: string; attest: SimHarness['attestors'][number]['attest'] }, rateWad: string): Promise<Record<string, unknown>> => {
    await t.pool.query('insert into fx_fallback_requests (request_id, chain, pair, period_id, reason) values ($1,$2,$3,$4,$5) on conflict (chain, pair, period_id) do nothing', [`fxreq_${h.sim.chain}_${pair.replace('/', '')}_${periodId}`, h.sim.chain, pair, periodId, 'coverage']);
    const id = (await t.pool.query<{ request_id: string }>('select request_id from fx_fallback_requests where chain = $1 and pair = $2 and period_id = $3', [h.sim.chain, pair, periodId])).rows[0]!.request_id;
    const owner = (await t.pool.query<{ account_id: string }>('select account_id from account_signer_keys where address = $1', [key.address])).rows[0]?.account_id ?? `acct-fx-${key.address}`;
    const tok = await attestorToken(owner, [key]);
    const m = await get(`/attestor/fx-requests/${id}/messages?rateWad=${rateWad}&attestor=${key.address}`, tok);
    if (m.statusCode !== 200) throw new Error(`test rig: FX messages ${m.statusCode} ${m.body}`);
    const signatures: { seriesId: string; signature: string }[] = [];
    for (const r of m.json().requests as { seriesId: string; seriesKey: string; domain: never; fields: never }[]) signatures.push({ seriesId: r.seriesId, signature: (await key.attest('FX', r.domain, r.seriesKey, r.fields)).signature });
    const s = await post(`/attestor/fx-requests/${id}/sign`, { rateWad, signer: key.address, sourceNote: 'test-rate', signatures }, tok);
    if (s.statusCode !== 200) throw new Error(`test rig: FX sign ${s.statusCode} ${s.body}`);
    return s.json();
  };
  /** Eligibility is checked live against the `eligibility` table, so a backer-tier token also needs a row: this seeds one and returns the token. */
  const grant = async (s: Partial<Session> & { wallets: Session['wallets'] }, kind: 'backer' | 'issuer' = 'backer') => {
    for (const w of s.wallets) await t.pool.query('insert into eligibility (chain, wallet, account_id, kind, allowlist_synced_at) values ($1,$2,$3,$4, now()) on conflict (chain, wallet) do update set revoked_at = null', [w.chain, w.address, s.accountId ?? 'acct', kind]);
    return token(s);
  };
  const get = (url: string, tok?: string) => app.inject({ method: 'GET', url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const post = (url: string, body: unknown, tok?: string, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } });
  const put = (url: string, body: unknown, tok?: string) => app.inject({ method: 'PUT', url, payload: body as Record<string, unknown>, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  return {
    t, sol, mon, ctx, app, indexer, token, grant, linkKeys, attestorToken, signFxFallback, get, post, put, del: (url: string, tok?: string) => app.inject({ method: 'DELETE', url, headers: tok ? { authorization: `Bearer ${tok}` } : {} }), esign, identity, zktls, verifier, kms,
    harness: (p: Personality) => (p === 'solana' ? sol : mon),
    async sync() {
      await indexer.catchUp();
    },
    async close() {
      await app.close();
      await t.drop();
      // snarkjs' worker threads (Groth16 proving and verifying) would keep the test worker alive
      await shutdownProofSystem();
    },
  };
}

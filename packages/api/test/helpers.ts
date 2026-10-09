import { createTestSchema } from '@merces/db';
import type { ChainRegistry } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import { buildApp, issueSession, makeContext, type Session } from '../src/index.ts';
import { createServiceContext, serviceRoutes } from '@merces/services';
import { LocalKms, MockESign, MockIdentityCheck, MockZkTls } from '@merces/ports';
import { ReportVerifier } from '@merces/report-verifier';

const GENESIS = Date.UTC(2026, 0, 1) / 1000;
export const SECRET = 'test-secret';

/** Test rig: one schema, two simulator harnesses, an indexer and the app with every route registered. */
export async function makeRig(opts: { genesis?: number; keyPrefix?: string; extraRoutes?: ((app: import('fastify').FastifyInstance, ctx: import('@merces/api').AppContext) => void)[] } = {}) {
  const t = await createTestSchema();
  const prefix = opts.keyPrefix ?? `t${Math.random().toString(36).slice(2, 7)}`;
  const sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: `solana`, genesis: opts.genesis ?? GENESIS }) });
  const mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: `monad`, genesis: opts.genesis ?? GENESIS }) });
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
  const kms = new LocalKms('test-seed');
  const verifier = new ReportVerifier(zktls, kms, 'report-verifier-test');
  const spki = await kms.spkiHex('report-verifier-test');
  for (const h of [sol, mon]) await h.exec(h.admin, { kind: 'registerVerifierKey', keyId: 'report-verifier-test', publicKey: spki, active: true });
  const ctx = createServiceContext(makeContext({ pool: t.pool, chains, log: silent, sessionSecret: SECRET, devMode: true }), { esign, identity, zktls, kms, verifier, reportVerifierUrl: 'http://verifier.test' });
  const app = await buildApp(ctx, [...serviceRoutes, ...(opts.extraRoutes ?? [])]);
  await app.ready();
  const token = (s: Partial<Session> & { wallets?: Session['wallets'] }) =>
    issueSession(SECRET, { accountId: s.accountId ?? 'acct', wallets: s.wallets ?? [], roles: s.roles ?? [], eligible: s.eligible ?? true, exp: Math.floor(Date.now() / 1000) + 3600 });
  /** Eligibility is checked live against the `eligibility` table, so a backer-tier token also needs a row: this seeds one and returns the token. */
  const grant = async (s: Partial<Session> & { wallets: Session['wallets'] }, kind: 'backer' | 'issuer' = 'backer') => {
    for (const w of s.wallets) await t.pool.query('insert into eligibility (chain, wallet, account_id, kind, allowlist_synced_at) values ($1,$2,$3,$4, now()) on conflict (chain, wallet) do update set revoked_at = null', [w.chain, w.address, s.accountId ?? 'acct', kind]);
    return token(s);
  };
  const get = (url: string, tok?: string) => app.inject({ method: 'GET', url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const post = (url: string, body: unknown, tok?: string, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } });
  const put = (url: string, body: unknown, tok?: string) => app.inject({ method: 'PUT', url, payload: body as Record<string, unknown>, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  return {
    t, sol, mon, ctx, app, indexer, token, grant, get, post, put, esign, identity, zktls, verifier, kms,
    harness: (p: Personality) => (p === 'solana' ? sol : mon),
    async sync() {
      await indexer.catchUp();
    },
    async close() {
      await app.close();
      await t.drop();
    },
  };
}

import { createTestSchema } from '@merces/db';
import type { ChainRegistry } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import { buildApp, issueSession, makeContext, type Session } from '../src/index.ts';
import { registerAllRoutes } from '../src/routes/all.ts';
import '../src/routes/services.ts';

const GENESIS = Date.UTC(2026, 0, 1) / 1000;
export const SECRET = 'test-secret';

/** Test rig: one schema, two simulator harnesses, an indexer and the app with every route registered. */
export async function makeRig(opts: { genesis?: number; keyPrefix?: string } = {}) {
  const t = await createTestSchema();
  const prefix = opts.keyPrefix ?? `t${Math.random().toString(36).slice(2, 7)}`;
  const sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: `solana`, genesis: opts.genesis ?? GENESIS }) });
  const mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: `monad`, genesis: opts.genesis ?? GENESIS }) });
  void prefix;
  const chains: ChainRegistry = {
    chains: new Map([[sol.sim.chain, sol.sim], [mon.sim.chain, mon.sim]]),
    decisions: [],
    stage1: null,
    get: (c) => (c === sol.sim.chain ? sol.sim : mon.sim),
    byFamily: (f) => (f === 'solana' ? sol.sim : mon.sim),
    close: async () => undefined,
  };
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
  const indexer = new Indexer(t.pool, [sol.sim, mon.sim], { logger: silent });
  const ctx = makeContext({ pool: t.pool, chains, log: silent, sessionSecret: SECRET, devMode: true });
  const app = await buildApp(ctx, [registerAllRoutes]);
  await app.ready();
  const token = (s: Partial<Session> & { wallets?: Session['wallets'] }) =>
    issueSession(SECRET, { accountId: s.accountId ?? 'acct', wallets: s.wallets ?? [], roles: s.roles ?? [], eligible: s.eligible ?? true, exp: Math.floor(Date.now() / 1000) + 3600 });
  const get = (url: string, tok?: string) => app.inject({ method: 'GET', url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const post = (url: string, body: unknown, tok?: string, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } });
  return {
    t, sol, mon, ctx, app, indexer, token, get, post,
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

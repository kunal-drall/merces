import { createLogger } from '@merces/core';
import { resolveSecret, simulatorOnly } from '@merces/ports';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains, subsetRegistry } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { KeeperScheduler, standardJobs } from '@merces/keepers';
import { HermesPyth, MockChainlink, MockPyth } from '@merces/ports';
import { buildApp, makeContext } from '@merces/api';
import { createServiceContext, notificationsOutboxHandler, serviceRoutes } from '@merces/services';

const log = createLogger('api');
const pool = createPool();
await migrate(pool);
const chains = await createChains(chainsConfigFromEnv(process.env, { pool, log: (m: string) => log.info(m) }));
const devMode = [...chains.chains.values()].every((c) => c.mode === 'mock') && process.env.MERCES_DEV_ROUTES !== 'false';
const sessionSecret = resolveSecret(process.env, 'MERCES_SESSION_SECRET', { simulatorOnly: simulatorOnly(chains), devDefault: 'dev-session-secret-not-for-production' });
const ctx = createServiceContext(makeContext({ pool, chains, log, sessionSecret, devMode }));
const app = await buildApp(ctx, serviceRoutes);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port, devMode, chains: chains.decisions }, 'api listening');

// A simulated chain lives in this process (its persisted state has one owner), so the API indexes it and runs its
// keepers here; the standalone indexer and keeper processes handle live chains only.
const sims = subsetRegistry(chains, (c) => c.mode === 'mock');
if (sims.chains.size) {
  void new Indexer(pool, [...sims.chains.values()], { logger: log }).runLoop(Number(process.env.INDEXER_POLL_MS ?? 2000));
  if (process.env.MERCES_KEEPERS !== 'false') {
    const kctx = createServiceContext(makeContext({ pool, chains: sims, log, sessionSecret, devMode }));
    const pyth = (process.env.MERCES_PRICE_FEED_PROVIDER ?? 'mock') === 'pyth' ? new HermesPyth(process.env.PYTH_HERMES_URL) : new MockPyth();
    void new KeeperScheduler(kctx, standardJobs({ pyth, chainlink: new MockChainlink(), outbox: notificationsOutboxHandler(kctx) })).start();
  }
  log.info({ chains: [...sims.chains.keys()], keepers: process.env.MERCES_KEEPERS !== 'false' }, 'simulated chains indexed and cranked in-process');
}

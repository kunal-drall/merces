import { createLogger } from '@merces/core';
import { resolveSecret, shutdownProofSystem, simulatorOnly } from '@merces/ports';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains, subsetRegistry } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { KeeperScheduler, standardJobs } from '@merces/keepers';
import { HermesPyth, MockChainlink, MockPyth } from '@merces/ports';
import { buildApp, makeContext } from '@merces/api';
import { createServiceContext, notificationsOutboxHandler, serviceRoutes } from '@merces/services';
import { formsConfig } from '../../services/src/forms/config.ts';
import { deliverFormMail, pruneForms } from '../../services/src/forms/mail.ts';

const log = createLogger('api');
const pool = createPool();
await migrate(pool);
const chains = await createChains(chainsConfigFromEnv(process.env, { pool, log: (m: string) => log.info(m) }));
const devMode = [...chains.chains.values()].every((c) => c.mode === 'mock') && process.env.MERCES_DEV_ROUTES !== 'false';
const sessionSecret = resolveSecret(process.env, 'MERCES_SESSION_SECRET', { simulatorOnly: simulatorOnly(chains), devDefault: 'dev-session-secret-not-for-production' });
const ctx = createServiceContext(makeContext({ pool, chains, log, sessionSecret, devMode }));
const app = await buildApp(ctx, serviceRoutes);
const background = new AbortController();
// A single hosted replica shares its RPC caches and database pool with the read indexer.
if (process.env.MERCES_INDEXER_IN_PROCESS === 'true') {
  const live = subsetRegistry(chains, c => c.mode === 'live');
  void new Indexer(pool, [...live.chains.values()], { logger: log }).runLoop(Number(process.env.INDEXER_POLL_MS ?? 15000), background.signal);
}
if (process.env.MERCES_FORMS_WORKER_IN_PROCESS === 'true') {
  const config = formsConfig();
  if (!config) throw Error('Hosted mail worker requires complete forms configuration');
  void (async () => {
    let cleanedAt = 0;
    while (!background.signal.aborted) {
      try {
        if (Date.now() - cleanedAt > 3600_000) { await pruneForms(pool); cleanedAt = Date.now(); }
        if (await deliverFormMail(pool, config)) continue;
      } catch { log.error('Forms delivery attempt failed; queued mail will retry'); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  })();
}
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
    // a mock feed publishes at the simulator's time (it time-travels), or every snapshot would be refused as stale
    const simClock = ([...sims.chains.values()][0] as unknown as { clock: { now(): number } }).clock;
    const pyth = (process.env.MERCES_PRICE_FEED_PROVIDER ?? 'mock') === 'pyth' ? new HermesPyth(process.env.PYTH_HERMES_URL,fetch,process.env.PYTH_API_KEY) : new MockPyth(undefined, () => simClock.now());
    void new KeeperScheduler(kctx, standardJobs({ pyth, chainlink: new MockChainlink(), outbox: notificationsOutboxHandler(kctx) })).start();
  }
  log.info({ chains: [...sims.chains.keys()], keepers: process.env.MERCES_KEEPERS !== 'false' }, 'simulated chains indexed and cranked in-process');
}

// shutdown: stop serving, release the persisted simulators' single-writer locks and the pool, then terminate the proof
// system's worker threads (Groth16 verification starts them; they would keep the process alive)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    log.info({ signal: sig }, 'shutting down');
    background.abort();
    void (async () => {
      await app.close().catch(() => undefined);
      await chains.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await shutdownProofSystem().catch(() => undefined);
      process.exit(0);
    })();
  });
}

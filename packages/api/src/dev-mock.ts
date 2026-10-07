/**
 * dev:mock — the whole backend on the simulator with the seeded synthetic cohort, so Stage 3 can start before
 * any chain is live. Persistent: state lives in Postgres under sim:<chain>; the first run seeds, later runs resume.
 */
import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { createChains } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { seedCohort } from '@merces/scenarios';
import { SimulatorChain } from '@merces/simulator';
import { buildApp } from './app.ts';
import { makeContext } from './context.ts';
import { registerAllRoutes } from './routes/all.ts';
import './routes/services.ts';

const log = createLogger('dev-mock');
const pool = createPool();
await migrate(pool);
const chains = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'mock', chainKey: 'monad' }, pool, persistKeyPrefix: process.env.MERCES_SIM_KEY ?? 'sim', log: (m: string) => log.info(m) });
const solana = chains.get('solana') as SimulatorChain;
const monad = chains.get('monad') as SimulatorChain;
if ((await solana.listSeries()).length === 0 && process.env.MERCES_SEED !== 'false') {
  log.info('seeding the synthetic pilot cohort');
  await seedCohort({ solana, monad }, { quarters: Number(process.env.MERCES_SEED_QUARTERS ?? 3), log: (m: string) => log.info(m) });
}
const indexer = new Indexer(pool, [solana, monad], { logger: log });
await indexer.catchUp();
const ctx = makeContext({ pool, chains, log, sessionSecret: process.env.MERCES_SESSION_SECRET ?? 'dev-session-secret-not-for-production', devMode: true });
const app = await buildApp(ctx, [registerAllRoutes]);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'dev:mock listening (simulator, both personalities)');
void indexer.runLoop(Number(process.env.INDEXER_POLL_MS ?? 1000));

import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains } from '@merces/chains';
import { Indexer } from './indexer.ts';

const log = createLogger('indexer');
const pool = createPool();
await migrate(pool);
// live chains only: a simulated chain is owned, indexed and cranked by the API process (one writer per chain)
const registry = await createChains(chainsConfigFromEnv(process.env, { pool, simulators: 'skip', log: (m: string) => log.info(m) }));
const indexer = new Indexer(pool, [...registry.chains.values()], { logger: log });
log.info({ chains: [...registry.chains.keys()] }, registry.chains.size ? 'indexer started' : 'indexer started with no live chains (simulated chains are indexed by the API process)');
await indexer.runLoop(Number(process.env.INDEXER_POLL_MS ?? 2000));

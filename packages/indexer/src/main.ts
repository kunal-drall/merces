import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains } from '@merces/chains';
import { Indexer } from './indexer.ts';

const log = createLogger('indexer');
const pool = createPool();
await migrate(pool);
const registry = await createChains(chainsConfigFromEnv(process.env, { pool, log: (m: string) => log.info(m) }));
const indexer = new Indexer(pool, [...registry.chains.values()], { logger: log });
log.info('indexer started');
await indexer.runLoop(Number(process.env.INDEXER_POLL_MS ?? 2000));

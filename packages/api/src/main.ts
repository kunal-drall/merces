import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains } from '@merces/chains';
import { buildApp } from './app.ts';
import { makeContext } from './context.ts';
import { registerAllRoutes } from './routes/all.ts';
import './routes/services.ts';

const log = createLogger('api');
const pool = createPool();
await migrate(pool);
const chains = await createChains(chainsConfigFromEnv(process.env, { pool, log: (m: string) => log.info(m) }));
const devMode = [...chains.chains.values()].every((c) => c.mode === 'mock') && process.env.MERCES_DEV_ROUTES !== 'false';
const ctx = makeContext({ pool, chains, log, sessionSecret: process.env.MERCES_SESSION_SECRET ?? 'dev-session-secret-not-for-production', devMode });
const app = await buildApp(ctx, [registerAllRoutes]);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port, devMode, chains: chains.decisions }, 'api listening');

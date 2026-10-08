import { createLogger } from '@merces/core';
import { resolveSecret, simulatorOnly } from '@merces/ports';
import { createPool, migrate } from '@merces/db';
import { chainsConfigFromEnv, createChains } from '@merces/chains';
import { buildApp, makeContext } from '@merces/api';
import { createServiceContext, serviceRoutes } from '@merces/services';

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

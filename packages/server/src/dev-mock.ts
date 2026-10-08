/**
 * dev:mock — the whole backend on the simulator with the seeded synthetic cohort, so Stage 3 can start before
 * any chain is live. Persistent: state lives in Postgres under sim:<chain>; the first run seeds, later runs resume.
 */
import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { createChains } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { KeeperScheduler, standardJobs } from '@merces/keepers';
import { MockChainlink, MockPyth } from '@merces/ports';
import { seedCohort } from '@merces/scenarios';
import { SimWallet, SimulatorChain, simAdminWallet } from '@merces/simulator';
import { PILOT_COHORT } from '@merces/fixtures';
import { buildApp, makeContext } from '@merces/api';
import { IdentityService, createServiceContext, serviceRoutes } from '@merces/services';

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
const ctx = createServiceContext(makeContext({ pool, chains, log, sessionSecret: process.env.MERCES_SESSION_SECRET ?? 'dev-session-secret-not-for-production', devMode: true }));
// Register the dev report-verifier key on both simulators (the standalone verifier derives the same key from the dev seed).
{
  const spki = await ctx.kms.spkiHex(process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1');
  for (const sim of [solana, monad]) {
    const keys = await sim.listVerifierKeys();
    if (!keys.some((k) => k.keyId === (process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1'))) {
      const admin = simAdminWallet(sim.family);
      const tx = await sim.build({ kind: 'registerVerifierKey', keyId: process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1', publicKey: spki, active: true }, admin.address);
      await sim.send(await admin.sign(tx));
    }
  }
}
// Accounts for the seeded wallets so Stage 3 can sign in as any persona (simulator signatures are accepted in mock mode).
const ids = new IdentityService(ctx);
for (const i of PILOT_COHORT) {
  const sim = i.chain === 'solana' ? solana : monad;
  const w = new SimWallet(sim.family, `issuer:${i.handle}`);
  await ids.seedAccount({ accountId: `acct-issuer-${i.handle}`, wallets: [{ chain: sim.chain, address: w.address, family: sim.family }], roles: ['issuer', 'backer'], eligible: true, kind: 'issuer' });
}
for (const n of [1, 2, 3, 4, 5]) {
  await ids.seedAccount({ accountId: `acct-backer-${n}`, wallets: [{ chain: 'solana', address: new SimWallet('solana', `backer-${n}`).address, family: 'solana' }, { chain: 'monad', address: new SimWallet('evm', `backer-${n}`).address, family: 'evm' }], roles: ['backer'], eligible: true });
}
for (const n of [1, 2]) {
  await ids.seedAccount({ accountId: `acct-attestor-${n}`, wallets: [{ chain: 'solana', address: new SimWallet('solana', `attestor-${n}`).address, family: 'solana' }, { chain: 'monad', address: new SimWallet('evm', `attestor-${n}`).address, family: 'evm' }], roles: ['attestor'], eligible: false });
}
await ids.seedAccount({ accountId: 'acct-admin', wallets: [{ chain: 'solana', address: simAdminWallet('solana').address, family: 'solana' }, { chain: 'monad', address: simAdminWallet('evm').address, family: 'evm' }], roles: ['admin'], eligible: false });
const app = await buildApp(ctx, serviceRoutes);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'dev:mock listening (simulator, both personalities)');
void indexer.runLoop(Number(process.env.INDEXER_POLL_MS ?? 1000));
// keepers in-process (mock Pyth prices; the outbox logs notifications until a channel is configured)
const keepers = new KeeperScheduler(ctx, standardJobs({ pyth: new MockPyth(undefined, () => solana.clock.now()), chainlink: new MockChainlink(), outbox: async (topic, payload) => log.info({ topic, kind: payload.kind }, 'notification') }));
if (process.env.MERCES_KEEPERS !== 'false') void keepers.start(undefined, Number(process.env.KEEPER_TICK_MS ?? 5000));

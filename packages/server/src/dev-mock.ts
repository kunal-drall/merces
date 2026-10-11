/**
 * dev:mock — the whole backend on the simulator with the seeded synthetic cohort, so Stage 3 can start before
 * any chain is live. Persistent: state lives in Postgres under sim:<chain>; the first run seeds, later runs resume.
 */
import { createLogger } from '@merces/core';
import { createPool, migrate } from '@merces/db';
import { createChains } from '@merces/chains';
import { Indexer } from '@merces/indexer';
import { KeeperScheduler, standardJobs } from '@merces/keepers';
import { MockChainlink, MockPyth, reportProofSystemFromEnv, shutdownProofSystem } from '@merces/ports';
import { seedCohort } from '@merces/scenarios';
import { SimSigner, SimWallet, SimulatorChain, simAdminWallet } from '@merces/simulator';
import { PILOT_COHORT } from '@merces/fixtures';
import { buildApp, makeContext } from '@merces/api';
import { IdentityService, createServiceContext, notificationsOutboxHandler, serviceRoutes } from '@merces/services';

const log = createLogger('dev-mock');
const pool = createPool();
await migrate(pool);
// every chain is the simulator here, so MERCES_PROOF_SYSTEM=mock may make the simulators and the API accept mock report
// proofs (forgeable; the registry logs the warning); the default is Stage 1 Groth16
const proofSystem = reportProofSystemFromEnv(process.env, { simulatorOnly: true });
const chains = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'mock', chainKey: 'monad' }, pool, persistKeyPrefix: process.env.MERCES_SIM_KEY ?? 'sim', proofSystem, log: (m: string) => log.info(m) });
const solana = chains.get('solana') as SimulatorChain;
const monad = chains.get('monad') as SimulatorChain;
if ((await solana.listSeries()).length === 0 && process.env.MERCES_SEED !== 'false') {
  log.info('seeding the synthetic pilot cohort');
  await seedCohort({ solana, monad }, { quarters: Number(process.env.MERCES_SEED_QUARTERS ?? 3), proofs: proofSystem === 'mock' ? 'mock' : 'groth16', log: (m: string) => log.info(m) });
}
const indexer = new Indexer(pool, [solana, monad], { logger: log });
await indexer.catchUp();
const ctx = createServiceContext(makeContext({ pool, chains, log, sessionSecret: process.env.MERCES_SESSION_SECRET ?? 'dev-session-secret-not-for-production', devMode: true }));
// Register the dev report-verifier key on both simulators by its 20-byte address (S4 WP6; the standalone verifier derives
// the same secp256k1 key from the dev seed). Skipped when it is already registered (a restart of a persisted chain).
{
  const address = await ctx.kms.signerAddress(process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1');
  for (const sim of [solana, monad]) {
    if (!(await sim.getSignerKey('verifier', address))?.active) {
      const admin = simAdminWallet(sim.family);
      const tx = await sim.build({ kind: 'registerVerifierKey', key: address }, admin.address);
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
// The dev attestors (S4 WP7, D4): published secp256k1 test keys (seeds `merces-dev-attestor:<n>`, not for production),
// registered on both simulators by their 20-byte addresses and linked to acct-attestor-<n>, so Stage 3 can act as an
// attestor. The account signs in on monad with the key itself (an EVM wallet at the key's address); the link is what
// grants attestor access, read live with the registry. Simulator only: seedSignerKeys refuses a process with a live
// chain (A-REV-9), and every chain of dev:mock is the simulator.
for (const n of [1, 2]) {
  const key = new SimSigner(`merces-dev-attestor:${n}`);
  for (const sim of [solana, monad]) {
    if (!(await sim.getSignerKey('attestor', key.address))?.active) {
      const admin = simAdminWallet(sim.family);
      await sim.send(await admin.sign(await sim.build({ kind: 'registerAttestor', attestor: key.address }, admin.address)));
    }
  }
  await ids.seedAccount({ accountId: `acct-attestor-${n}`, wallets: [{ chain: 'monad', address: key.address, family: 'evm' }], roles: [], eligible: false });
  await ids.seedSignerKeys(`acct-attestor-${n}`, [key.address]);
}
await ids.seedAccount({ accountId: 'acct-admin', wallets: [{ chain: 'solana', address: simAdminWallet('solana').address, family: 'solana' }, { chain: 'monad', address: simAdminWallet('evm').address, family: 'evm' }], roles: ['admin'], eligible: false });
const app = await buildApp(ctx, serviceRoutes);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'dev:mock listening (simulator, both personalities)');
void indexer.runLoop(Number(process.env.INDEXER_POLL_MS ?? 1000));
// keepers in-process (mock Pyth prices; the outbox logs notifications until a channel is configured)
const keepers = new KeeperScheduler(ctx, standardJobs({ pyth: new MockPyth(undefined, () => solana.clock.now()), chainlink: new MockChainlink(), outbox: notificationsOutboxHandler(ctx) }));
const keeperStop = new AbortController();
if (process.env.MERCES_KEEPERS !== 'false') void keepers.start(keeperStop.signal, Number(process.env.KEEPER_TICK_MS ?? 5000));

// shutdown: stop serving, release the simulators' single-writer locks and the pool, terminate the proof system's threads
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    log.info({ signal: sig }, 'shutting down');
    void (async () => {
      keeperStop.abort();
      await app.close().catch(() => undefined);
      await chains.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await shutdownProofSystem().catch(() => undefined);
      process.exit(0);
    })();
  });
}

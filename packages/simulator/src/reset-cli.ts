/**
 * `pnpm --filter @merces/simulator sim:reset [--chain solana,monad] [--prefix sim] [--dry-run]`
 *
 * Deletes the persisted simulator chains (state, events, indexer projections and the off-chain rows keyed by their
 * series), see reset.ts and RUNBOOK.md "Simulator state version 3: reset". Refuses unless MERCES_ALLOW_SIM_RESET=1;
 * `--dry-run` (allowed without it) prints what would be deleted and rolls back.
 * DATABASE_URL selects the database; MERCES_SIM_KEY the key prefix (as for the API and dev:mock).
 */
import { createPool, databaseUrl } from '@merces/db';
import { SimResetError, formatSimResetReport, resetSimulatorChains, simResetAllowed } from './reset.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !simResetAllowed()) {
  console.error('sim:reset deletes persisted simulator chains and the rows keyed to them; set MERCES_ALLOW_SIM_RESET=1 to run it (see RUNBOOK.md)');
  process.exit(2);
}
const prefix = arg('prefix') ?? process.env.MERCES_SIM_KEY ?? 'sim';
const chainArg = arg('chain') ?? arg('chains');
const chains = chainArg ? chainArg.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
const pool = createPool(databaseUrl());
try {
  const report = await resetSimulatorChains(pool, { prefix, chains, dryRun });
  console.log(formatSimResetReport(report, prefix));
} catch (e) {
  if (!(e instanceof SimResetError)) throw e;
  console.error(`sim:reset refused: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

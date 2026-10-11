import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalKms, MockZkTls } from '@merces/ports';
import { DEV_KEY_SEED, ReportVerifier, VerifierConfigError, verifierChainsFromEnv, verifierChainsFromPorts, verifierSetupFromEnv } from '@merces/report-verifier';
import { SimulatorChain } from '@merces/simulator';

/*
 * S4 cause codes:
 *  - S4-T2: the standalone report verifier's dev chain table (`MERCES_VERIFIER_CHAINS` in .env.example and
 *    docker-compose.yml) is the dev:mock simulators' own signing domains (S4 amendment D10: the simulator registries are
 *    derived per chain key, which no operator writes by hand), so the values shipped are checked here against each
 *    simulator's `ChainInfo.signing`, the table the in-process verifier derives. Development (`MERCES_VERIFIER_DEV=true`,
 *    the published dev seed, no pin) is the simulator only: the entry point refuses to start when its table holds a live
 *    chain, a testnet included (S4 WP6 fix 1, A-REV-9).
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The value of `name` in a dotenv file or a compose environment block (single-quoted JSON). */
function valueIn(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  if (!m) throw new Error(`no ${pattern} in the file`);
  return m[1]!;
}

describe('the report verifier\'s dev chain table (S4-T2)', () => {
  it('.env.example and docker-compose.yml carry the dev simulators\' own signing domains, which the verifier accepts only in development', async () => {
    const sims = [SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana' }), SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad' })];
    const derived = await verifierChainsFromPorts(sims);
    const env = valueIn(readFileSync(ROOT + '.env.example', 'utf8'), /^MERCES_VERIFIER_CHAINS='(.+)'$/m);
    const compose = valueIn(readFileSync(ROOT + 'docker-compose.yml', 'utf8'), /^\s+MERCES_VERIFIER_CHAINS: '(.+)'$/m);
    expect(compose).toBe(env);
    expect(verifierChainsFromEnv(env)).toEqual(derived);
    expect(derived.map((c) => [c.chain, c.domain.chainKind, c.domain.chainId])).toEqual([['solana', 1, '104'], ['monad', 2, '31337']]);
    // local ids: accepted with MERCES_VERIFIER_DEV=true (allowLocal) only
    const kms = new LocalKms('dev-seed-not-for-production', { 'report-verifier-1': 'secp256k1' });
    await expect(ReportVerifier.create(new MockZkTls(), kms, { keyId: 'report-verifier-1', chains: verifierChainsFromEnv(env) })).rejects.toThrow(VerifierConfigError);
    const v = await ReportVerifier.create(new MockZkTls(), kms, { keyId: 'report-verifier-1', chains: verifierChainsFromEnv(env), allowLocal: true });
    expect((await v.publicKey()).chains).toEqual(derived);
    // the shipped development settings: the dev seed, no pin, the local ids only
    const dev = verifierSetupFromEnv({ MERCES_VERIFIER_DEV: 'true', MERCES_KMS_PROVIDER: 'local', MERCES_LOCAL_KEY_SEED: DEV_KEY_SEED, MERCES_VERIFIER_CHAINS: env });
    expect(dev.seed).toBe(DEV_KEY_SEED);
    expect(dev.config).toMatchObject({ address: null, chains: derived, allowLocal: true, localOnly: true });
  });

  it('the entry point refuses MERCES_VERIFIER_DEV=true with a live chain: the dev seed never signs for Solana devnet (S4 WP6 fix 1)', () => {
    // the reviewer's reproduction: dev mode, no seed (the dev default), Solana devnet (103) in the table, no pin; it
    // used to start and serve /keys. On port 0, so a regression listens harmlessly until the timeout fails the test.
    const devnet = JSON.stringify([{ chain: 'solana-devnet', family: 'solana', chainKind: 1, chainId: '103', registry: 'Agp61Ua3L6amzQ3F5qZfdaPFqRKLxW6Ldvfny1uRNLcR' }]);
    const r = spawnSync(ROOT + 'node_modules/.bin/tsx', [ROOT + 'packages/report-verifier/src/main.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MERCES_VERIFIER_DEV: 'true', MERCES_VERIFIER_CHAINS: devnet, REPORT_VERIFIER_PORT: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull(); // null: killed by the timeout, i.e. it started
    expect(r.stdout).not.toMatch(/listening/);
    expect(r.stderr).toMatch(/MERCES_VERIFIER_DEV=true is for the simulator only, and solana-devnet is not a local chain/);
  });
});

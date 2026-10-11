import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalKms, MockZkTls } from '@merces/ports';
import { ReportVerifier, VerifierConfigError, verifierChainsFromEnv, verifierChainsFromPorts } from '@merces/report-verifier';
import { SimulatorChain } from '@merces/simulator';

/*
 * S4 cause codes:
 *  - S4-T2: the standalone report verifier's dev chain table (`MERCES_VERIFIER_CHAINS` in .env.example and
 *    docker-compose.yml) is the dev:mock simulators' own signing domains (S4 amendment D10: the simulator registries are
 *    derived per chain key, which no operator writes by hand), so the values shipped are checked here against each
 *    simulator's `ChainInfo.signing`, the table the in-process verifier derives.
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
  });
});

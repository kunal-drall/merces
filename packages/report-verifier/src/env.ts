import { isLocalSigningDomain } from '@merces/domain';
import { assertSyntheticIncomeNetwork, resolveSecret } from '@merces/ports';
import { VerifierConfigError, previousAddressesFromEnv, verifierChainsFromEnv, type ReportVerifierConfig, type VerifierChain } from './verifier.ts';

/** The local KMS's published development seed: the simulator only, never a live network. */
export const DEV_KEY_SEED = 'dev-seed-not-for-production';

/** The standalone verifier's settings, read from its environment by `verifierSetupFromEnv`. */
export interface VerifierEnvSetup {
  /** `MERCES_LOCAL_KEY_SEED` for the local KMS: the published dev seed only in development with local chains only */
  seed: string;
  config: ReportVerifierConfig & { chains: VerifierChain[] };
}

/**
 * The standalone verifier's settings from its environment (`main.ts`). The verifier has no chain registry, and its key
 * is the one the multisig registers onchain, so it fails closed; its own chain table (`MERCES_VERIFIER_CHAINS`) is what
 * tells it whether a chain is live:
 *  - `MERCES_VERIFIER_DEV=true` is development on the simulator only: every chain of the table must be a local id
 *    (Solana localnet 104, EVM 31337), else it refuses to start. Only then are the published dev seed accepted and the
 *    address pin waived, and the verifier runs `localOnly` (a testnet domain refused at every signature too);
 *  - otherwise the seed must be a secret (at least 32 characters, never the dev seed), `REPORT_VERIFIER_ADDRESS` is
 *    required, and the local ids are refused (the table is testnets only: never mainnet).
 * A cloud KMS waits for the owner's choice of provider (STAGE1_INTEGRATION.md "Owner decisions and questions", S4
 * question 1): the port, the DER normaliser and the provider-neutral adapter exist (`RemoteSecp256k1Kms`), no provider
 * is wired, so anything but the local signer is refused. Messages name no secret.
 */
export function verifierSetupFromEnv(env: NodeJS.ProcessEnv): VerifierEnvSetup {
  if (env.MERCES_KMS_PROVIDER && env.MERCES_KMS_PROVIDER !== 'local') throw new VerifierConfigError('cloud KMS not configured: no provider is chosen yet (S4 owner question 1)');
  const dev = env.MERCES_VERIFIER_DEV === 'true';
  // its own chain table: the domains it signs under, checked against the signing allow-list at startup (never mainnet)
  const chains = verifierChainsFromEnv(env.MERCES_VERIFIER_CHAINS);
  const live = chains.filter((c) => !isLocalSigningDomain(c.domain)).map((c) => c.chain);
  if (dev && live.length > 0) {
    throw new VerifierConfigError(`MERCES_VERIFIER_DEV=true is for the simulator only, and ${live.join(', ')} ${live.length === 1 ? 'is not a local chain' : 'are not local chains'} (Solana localnet 104, EVM 31337): the development seed and the waived address pin are refused when a chain is live`);
  }
  const simulatorOnly = dev && live.length === 0;
  const seed = resolveSecret(env, 'MERCES_LOCAL_KEY_SEED', { simulatorOnly, devDefault: DEV_KEY_SEED, devHint: 'the development seed is accepted only with MERCES_VERIFIER_DEV=true and local chains only' });
  // the address pin: outside development the verifier starts only when the KMS key is the key registered onchain
  const address = env.REPORT_VERIFIER_ADDRESS?.trim() || null;
  if (!address && !simulatorOnly) throw new VerifierConfigError('REPORT_VERIFIER_ADDRESS is not set: the verifier starts only with the address of the key registered onchain (S4 D10)');
  const provider = env.MERCES_ZKTLS_PROVIDER ?? 'mock';
  if (provider === 'synthetic' && env.MERCES_TEST_INCOME === 'true') {
    for (const chain of chains) assertSyntheticIncomeNetwork(chain.domain);
  } else {
    if (provider !== 'mock') throw new VerifierConfigError('the configured zkTLS provider is not wired yet (Part J.3); synthetic requires MERCES_TEST_INCOME=true');
    if (live.length > 0) throw new VerifierConfigError('mock zkTLS is simulator-only: a real zkTLS provider is required before live reporting (Part J.3)');
  }
  return {
    seed,
    config: {
      keyId: env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1',
      address,
      previous: previousAddressesFromEnv(env.REPORT_VERIFIER_PREVIOUS_ADDRESSES),
      chains,
      allowLocal: simulatorOnly,
      localOnly: simulatorOnly,
    },
  };
}

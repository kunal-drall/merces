import { LocalKms, incomeProviderFromEnv, SyntheticIncomeZkTls, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier } from './verifier.ts';
import { verifierSetupFromEnv } from './env.ts';
import { createVerifierServer } from './server.ts';

// The verifier has no chain registry, and its key is the one the multisig registers onchain: it fails closed. Its own
// chain table tells it whether a chain is live: the published dev seed, the waived address pin and the local chain ids
// need MERCES_VERIFIER_DEV=true AND a table of local ids only (verifierSetupFromEnv); a cloud KMS is refused until the
// owner chooses a provider (S4 question 1).
const { seed, config } = verifierSetupFromEnv(process.env);
// the key's algorithm is configuration (S4 WP3): Stage 1's secp256k1 (S4 WP6, D10)
const kms = new LocalKms(seed, { [config.keyId]: 'secp256k1' });
const provider = incomeProviderFromEnv(process.env, { simulatorOnly: config.localOnly === true });
const verifier = await ReportVerifier.create(provider, kms, config);
const info = await verifier.publicKey();
const port = Number(process.env.REPORT_VERIFIER_PORT ?? 3100);
const server = createVerifierServer(verifier, undefined, { synthetic: provider instanceof SyntheticIncomeZkTls ? provider : undefined, allowedOrigins: (process.env.MERCES_VERIFIER_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) }).listen(port, process.env.REPORT_VERIFIER_HOST ?? '127.0.0.1', () => process.stdout.write(`report-verifier listening on :${port} (keyId=${config.keyId}, address=${info.address}, chains=${info.chains.map((c) => c.chain).join(',')})\n`));
// on shutdown: stop accepting requests, then release the proof system's worker threads (if anything started them)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    server.close(() => void shutdownProofSystem().finally(() => process.exit(0)));
  });
}

import { LocalKms, MockZkTls, resolveSecret, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier } from './verifier.ts';
import { createVerifierServer } from './server.ts';

const provider = process.env.MERCES_ZKTLS_PROVIDER ?? 'mock';
if (provider !== 'mock') throw new Error(`zkTLS provider ${provider} is not wired yet (Part J.3)`);
// The verifier has no chain registry to tell it whether anything is live, and its key is the one the multisig
// registers onchain: it fails closed and accepts the published dev seed only with an explicit MERCES_VERIFIER_DEV=true.
// A cloud KMS waits for the owner's choice of provider (STAGE1_INTEGRATION.md "Owner decisions and questions", S4
// question 1): the port, the DER normaliser and the provider-neutral adapter exist (`RemoteSecp256k1Kms`), no provider
// is wired, so anything but the local signer is refused.
if (process.env.MERCES_KMS_PROVIDER && process.env.MERCES_KMS_PROVIDER !== 'local') throw new Error('cloud KMS not configured: no provider is chosen yet (S4 owner question 1)');
const keyId = process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1';
// the key's algorithm is configuration (S4 WP3): ed25519 until S4 WP6 moves the verifier to Stage 1's secp256k1 key
const kms = new LocalKms(resolveSecret(process.env, 'MERCES_LOCAL_KEY_SEED', { simulatorOnly: process.env.MERCES_VERIFIER_DEV === 'true', devDefault: 'dev-seed-not-for-production', devHint: 'the development seed is accepted only with MERCES_VERIFIER_DEV=true' }), { [keyId]: 'ed25519' });
const verifier = new ReportVerifier(new MockZkTls(), kms, keyId);
const port = Number(process.env.REPORT_VERIFIER_PORT ?? 3100);
const server = createVerifierServer(verifier).listen(port, () => process.stdout.write(`report-verifier listening on :${port} (keyId=${keyId})\n`));
// on shutdown: stop accepting requests, then release the proof system's worker threads (if anything started them)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    server.close(() => void shutdownProofSystem().finally(() => process.exit(0)));
  });
}

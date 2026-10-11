import { LocalKms, MockZkTls, resolveSecret, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier, previousAddressesFromEnv, verifierChainsFromEnv } from './verifier.ts';
import { createVerifierServer } from './server.ts';

const provider = process.env.MERCES_ZKTLS_PROVIDER ?? 'mock';
if (provider !== 'mock') throw new Error(`zkTLS provider ${provider} is not wired yet (Part J.3)`);
// The verifier has no chain registry to tell it whether anything is live, and its key is the one the multisig
// registers onchain: it fails closed and accepts the published dev seed and the local chain ids only with an explicit
// MERCES_VERIFIER_DEV=true.
const dev = process.env.MERCES_VERIFIER_DEV === 'true';
// A cloud KMS waits for the owner's choice of provider (STAGE1_INTEGRATION.md "Owner decisions and questions", S4
// question 1): the port, the DER normaliser and the provider-neutral adapter exist (`RemoteSecp256k1Kms`), no provider
// is wired, so anything but the local signer is refused.
if (process.env.MERCES_KMS_PROVIDER && process.env.MERCES_KMS_PROVIDER !== 'local') throw new Error('cloud KMS not configured: no provider is chosen yet (S4 owner question 1)');
const keyId = process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1';
// the key's algorithm is configuration (S4 WP3): Stage 1's secp256k1 (S4 WP6, D10)
const kms = new LocalKms(resolveSecret(process.env, 'MERCES_LOCAL_KEY_SEED', { simulatorOnly: dev, devDefault: 'dev-seed-not-for-production', devHint: 'the development seed is accepted only with MERCES_VERIFIER_DEV=true' }), { [keyId]: 'secp256k1' });
// the address pin: outside development the verifier starts only when the KMS key is the key registered onchain
const address = process.env.REPORT_VERIFIER_ADDRESS?.trim() || null;
if (!address && !dev) throw new Error('REPORT_VERIFIER_ADDRESS is not set: the verifier starts only with the address of the key registered onchain (S4 D10)');
const verifier = await ReportVerifier.create(new MockZkTls(), kms, {
  keyId,
  address,
  previous: previousAddressesFromEnv(process.env.REPORT_VERIFIER_PREVIOUS_ADDRESSES),
  // its own chain table: the domains it signs under, checked against the signing allow-list (never mainnet)
  chains: verifierChainsFromEnv(process.env.MERCES_VERIFIER_CHAINS),
  allowLocal: dev,
});
const info = await verifier.publicKey();
const port = Number(process.env.REPORT_VERIFIER_PORT ?? 3100);
const server = createVerifierServer(verifier).listen(port, () => process.stdout.write(`report-verifier listening on :${port} (keyId=${keyId}, address=${info.address}, chains=${info.chains.map((c) => c.chain).join(',')})\n`));
// on shutdown: stop accepting requests, then release the proof system's worker threads (if anything started them)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    server.close(() => void shutdownProofSystem().finally(() => process.exit(0)));
  });
}

import { LocalKms, MockZkTls, resolveSecret } from '@merces/ports';
import { ReportVerifier } from './verifier.ts';
import { createVerifierServer } from './server.ts';

const provider = process.env.MERCES_ZKTLS_PROVIDER ?? 'mock';
if (provider !== 'mock') throw new Error(`zkTLS provider ${provider} is not wired yet (Part J.3)`);
// The verifier has no chain registry to tell it whether anything is live, and its key is the one the multisig
// registers onchain: it fails closed and accepts the published dev seed only with an explicit MERCES_VERIFIER_DEV=true.
const kms = new LocalKms(resolveSecret(process.env, 'MERCES_LOCAL_KEY_SEED', { simulatorOnly: process.env.MERCES_VERIFIER_DEV === 'true', devDefault: 'dev-seed-not-for-production', devHint: 'the development seed is accepted only with MERCES_VERIFIER_DEV=true' }));
if (process.env.MERCES_KMS_PROVIDER && process.env.MERCES_KMS_PROVIDER !== 'local') throw new Error('cloud KMS not configured (Part J.2)');
const verifier = new ReportVerifier(new MockZkTls(), kms, process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1');
const port = Number(process.env.REPORT_VERIFIER_PORT ?? 3100);
createVerifierServer(verifier).listen(port, () => process.stdout.write(`report-verifier listening on :${port} (keyId=${process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1'})\n`));

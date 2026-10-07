import { LocalKms, MockZkTls } from '@merces/ports';
import { ReportVerifier } from './verifier.ts';
import { createVerifierServer } from './server.ts';

const provider = process.env.MERCES_ZKTLS_PROVIDER ?? 'mock';
if (provider !== 'mock') throw new Error(`zkTLS provider ${provider} is not wired yet (Part J.3)`);
const kms = new LocalKms(process.env.MERCES_LOCAL_KEY_SEED ?? 'dev-seed-not-for-production');
if (process.env.MERCES_KMS_PROVIDER && process.env.MERCES_KMS_PROVIDER !== 'local') throw new Error('cloud KMS not configured (Part J.2)');
const verifier = new ReportVerifier(new MockZkTls(), kms, process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1');
const port = Number(process.env.REPORT_VERIFIER_PORT ?? 3100);
createVerifierServer(verifier).listen(port, () => process.stdout.write(`report-verifier listening on :${port} (keyId=${process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1'})\n`));

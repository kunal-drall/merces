// Export only committed runtime inputs. Railway builds do not need private submodule credentials.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const pin = JSON.parse(readFileSync('stage1.map.json', 'utf8')).commit;
const actual = execFileSync('git', ['-C', 'stage1', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (pin !== actual) throw Error('Stage 1 checkout differs from the reviewed pin');
const paths = ['LICENSE.md', 'tsconfig.base.json', 'packages/sdk', 'packages/reference', 'circuits', 'solana/meteora', 'solana/idls', 'evm/abis'];
const archive = execFileSync('git', ['-C', 'stage1', 'archive', '--format=tar.gz', pin, ...paths], { maxBuffer: 32 * 1024 * 1024 });
mkdirSync('deployment', { recursive: true });
writeFileSync('deployment/stage1-runtime.tar.gz', archive);
writeFileSync('deployment/stage1-runtime.json', JSON.stringify({ commit: pin, sha256: createHash('sha256').update(archive).digest('hex'), paths }, null, 2) + '\n');

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
const pin = JSON.parse(readFileSync('stage1.map.json', 'utf8')).commit;
const bundle = JSON.parse(readFileSync('deployment/stage1-runtime.json', 'utf8'));
const archive = readFileSync('deployment/stage1-runtime.tar.gz');
if (bundle.commit !== pin || createHash('sha256').update(archive).digest('hex') !== bundle.sha256) throw Error('Stage 1 runtime bundle differs from its pin');
mkdirSync('stage1', { recursive: true });
execFileSync('tar', ['-xzf', 'deployment/stage1-runtime.tar.gz', '-C', 'stage1']);

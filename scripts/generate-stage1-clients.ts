import { locateStage1 } from '../packages/chains/src/manifest.ts';
import { generateClients } from '../packages/stage1-sync/src/steps/generate.ts';

// Offline install bootstrap, before any adapter is imported. Always use the checked-out Stage 1 pin.
const location = locateStage1('stage1');
if (!location) throw new Error('Stage 1 manifest or repository map is required to generate the adapter clients');
const result = await generateClients({ location, outDir: 'packages/stage1-sync/out', generatedDir: 'packages/stage1-sync/generated' });
for (const detail of result.details) console.log(detail);
if (result.status !== 'ok') process.exitCode = 1;

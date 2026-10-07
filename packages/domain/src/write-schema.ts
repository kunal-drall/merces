import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { domainJsonSchema } from './schema.ts';

const out = fileURLToPath(new URL('../schema/domain-v0.schema.json', import.meta.url));
writeFileSync(out, JSON.stringify(domainJsonSchema(), null, 2) + '\n');
console.log(`wrote ${out}`);

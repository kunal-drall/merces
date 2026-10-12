import { assertHostedConfig } from './hosted-config.ts';
assertHostedConfig(process.env);
await import('./main.ts');

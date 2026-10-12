import { describe, expect, it } from 'vitest';
import { assertHostedConfig } from '../src/hosted-config.ts';
const valid = { MERCES_CHAIN_SOLANA_MODE: 'live', MERCES_CHAIN_EVM_MODE: 'live', STAGE1_PATH: './deployment', DATABASE_URL: 'postgres://test', MERCES_DEV_ROUTES: 'false', MERCES_SEED: 'false', MERCES_PROOF_SYSTEM: 'groth16' };
describe('hosted configuration', () => {
  it('accepts explicit live deployments', () => expect(() => assertHostedConfig(valid)).not.toThrow());
  it.each(['MERCES_CHAIN_SOLANA_MODE', 'MERCES_CHAIN_EVM_MODE', 'STAGE1_PATH', 'DATABASE_URL', 'MERCES_DEV_ROUTES', 'MERCES_SEED', 'MERCES_PROOF_SYSTEM'])('refuses a missing safety setting: %s', key => expect(() => assertHostedConfig({ ...valid, [key]: undefined })).toThrow());
  it.each(['auto', 'mock'])('refuses %s chain fallback', value => expect(() => assertHostedConfig({ ...valid, MERCES_CHAIN_SOLANA_MODE: value })).toThrow());
});

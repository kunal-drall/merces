import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChains, locateStage1 } from '../src/index.ts';

describe('mode selection (D4)', () => {
  it('reports Stage 1 not present and falls back to simulators in auto mode', async () => {
    const reg = await createChains({ solana: { mode: 'auto' }, evm: { mode: 'auto', chainKey: 'monad' }, stage1Path: undefined, log: () => undefined });
    expect(reg.stage1).toBeNull();
    expect(reg.decisions.map((d) => d.chosen)).toEqual(['mock', 'mock']);
    expect(reg.decisions[0]!.reason).toContain('Stage 1 not present');
    expect(reg.get('solana').family).toBe('solana');
    expect(reg.get('monad').family).toBe('evm');
    expect(reg.get('monad').mode).toBe('mock');
  });
  it('mode=live fails loudly when no Stage 1 entry exists', async () => {
    await expect(createChains({ solana: { mode: 'live' }, evm: { mode: 'mock', chainKey: 'monad' }, log: () => undefined })).rejects.toThrow(/live adapter is unavailable/);
  });
  it('decides per chain: a manifest with a Solana entry pointing at an unreachable RPC falls back only for Solana', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
    mkdirSync(join(dir, 'handoff'));
    writeFileSync(join(dir, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', solana: { cluster: 'devnet', rpcUrl: 'http://127.0.0.1:1', programs: { series: '11111111111111111111111111111111' }, idlDir: 'idl' } }));
    const reg = await createChains({ solana: { mode: 'auto' }, evm: { mode: 'auto', chainKey: 'monad' }, stage1Path: dir, log: () => undefined });
    expect(reg.stage1?.kind).toBe('manifest');
    expect(reg.decisions.find((d) => d.chain === 'solana')!.reason).toMatch(/health check failed/);
    expect(reg.decisions.find((d) => d.chain === 'monad')!.reason).toMatch(/no Stage 1 entry/);
  });
  it('refuses mainnet configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
    writeFileSync(join(dir, 'stage1.map.json'), JSON.stringify({ evm: [{ chain: 'monad-mainnet', chainId: 143, rpcUrl: 'https://rpc.monad.xyz', contracts: { series: '0x' + '11'.repeat(20) } }] }));
    const loc = locateStage1(dir);
    expect(loc?.kind).toBe('map');
    await expect(createChains({ solana: { mode: 'mock' }, evm: { mode: 'live', chainKey: 'monad' }, stage1Path: dir, log: () => undefined })).rejects.toThrow(/mainnet/);
  });
  it('tolerates a malformed manifest by reporting problems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
    mkdirSync(join(dir, 'handoff'));
    writeFileSync(join(dir, 'handoff', 'manifest.json'), JSON.stringify({ evm: 'nope' }));
    const loc = locateStage1(dir)!;
    expect(loc.problems.length).toBeGreaterThan(0);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Groth16ReportVerifier } from '@merces/ports';
import type { SimulatorChain } from '@merces/simulator';
import { chainsConfigFromEnv, createChains, evmConfigFrom, locateStage1 } from '../src/index.ts';
import { evmRpc, fakeRpc, EVM_CONTRACTS } from './fake-rpc.ts';

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
  it('auto selects the wired live adapter only after complete deployment health succeeds', async () => {
    const rpc = await fakeRpc(evmRpc(10143));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
      mkdirSync(join(dir, 'handoff'));
      writeFileSync(join(dir, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', evm: [{ chain: 'monad-testnet', chainId: 10143, rpcUrl: rpc.url, contracts: EVM_CONTRACTS }] }));
      const auto = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'auto', chainKey: 'monad' }, stage1Path: dir, log: () => undefined });
      const d = auto.decisions.find((x) => x.chain === 'monad')!;
      // S5: pinned ABI builders/reads/events now implement the port; health verifies registry module links.
      expect(d.chosen).toBe('live');
      expect(d.reason).toMatch(/chainId 10143/);
      expect(auto.get('monad').mode).toBe('live');
      await auto.close();
      const live = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'live', chainKey: 'monad' }, stage1Path: dir, log: () => undefined });
      expect(live.decisions.find((x) => x.chain === 'monad')!.chosen).toBe('live');
      await live.close();
    } finally {
      await rpc.close();
    }
  });
  it('tolerates a malformed manifest by reporting problems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
    mkdirSync(join(dir, 'handoff'));
    writeFileSync(join(dir, 'handoff', 'manifest.json'), JSON.stringify({ evm: 'nope' }));
    const loc = locateStage1(dir)!;
    expect(loc.problems.length).toBeGreaterThan(0);
  });

  it('picks the exact EVM manifest entry before any prefix match', () => {
    const root = mkdtempSync(join(tmpdir(), 'stage1-'));
    mkdirSync(join(root, 'handoff'));
    const entry = (chain: string, addr: string) => ({ chain, chainId: 10143, contracts: { Series: addr } });
    writeFileSync(join(root, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', evm: [entry('monad-testnet-v2', '0x' + '22'.repeat(20)), entry('monad-testnet', '0x' + '11'.repeat(20))] }));
    const loc = locateStage1(root)!;
    expect(evmConfigFrom(loc, 'monad-testnet')!.network).toBe('monad-testnet');
    expect(evmConfigFrom(loc, 'monad')!.network).toBe('monad-testnet-v2'); // no exact entry: chain id, then prefix
  });

  it("simulators: 'skip' leaves simulated chains out of a process that does not own them", async () => {
    const reg = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'auto', chainKey: 'monad' }, stage1Path: undefined, simulators: 'skip', log: () => undefined });
    expect(reg.chains.size).toBe(0);
    expect(reg.decisions.map((d) => [d.chain, d.chosen])).toEqual([['solana', 'mock'], ['monad', 'mock']]);
    expect(reg.decisions.every((d) => /not opened here/.test(d.reason))).toBe(true);
  });
});

describe('report proofs on simulator chains (critique H3)', () => {
  const opts = (c: unknown) => (c as SimulatorChain).engine.opts;
  it('simulators verify Stage 1 Groth16 proofs and refuse mock proofs by default', async () => {
    const reg = await createChains({ solana: { mode: 'mock' }, evm: { mode: 'mock', chainKey: 'monad' }, log: () => undefined });
    for (const c of reg.chains.values()) {
      expect(opts(c).acceptMockProofs).toBe(false);
      expect(opts(c).reportProofVerifier).toBeInstanceOf(Groth16ReportVerifier);
    }
    expect(chainsConfigFromEnv({}).proofSystem).toBe('groth16-bn254');
  });
  it('MERCES_PROOF_SYSTEM=mock: accepted in a simulator-only process, with a warning', async () => {
    const lines: string[] = [];
    const reg = await createChains({ ...chainsConfigFromEnv({ MERCES_PROOF_SYSTEM: 'mock', MERCES_CHAIN_SOLANA_MODE: 'mock', MERCES_CHAIN_EVM_MODE: 'mock' }), log: (m) => lines.push(m) });
    for (const c of reg.chains.values()) {
      expect(opts(c).acceptMockProofs).toBe(true);
      expect(opts(c).reportProofVerifier).toBeInstanceOf(Groth16ReportVerifier);
    }
    expect(lines.filter((l) => l.startsWith('WARNING') && /MOCK report proofs/.test(l))).toHaveLength(1);
    expect(() => chainsConfigFromEnv({ MERCES_PROOF_SYSTEM: 'plonk' })).toThrow(/MERCES_PROOF_SYSTEM/);
  });
  it('MERCES_PROOF_SYSTEM=mock is refused when a chain is live', async () => {
    const rpc = await fakeRpc(evmRpc(10143));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'stage1-'));
      mkdirSync(join(dir, 'handoff'));
      writeFileSync(join(dir, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', evm: [{ chain: 'monad-testnet', chainId: 10143, rpcUrl: rpc.url, contracts: EVM_CONTRACTS }] }));
      await expect(createChains({ solana: { mode: 'mock' }, evm: { mode: 'live', chainKey: 'monad' }, stage1Path: dir, proofSystem: 'mock', log: () => undefined })).rejects.toThrow(/MERCES_PROOF_SYSTEM=mock is refused/);
    } finally {
      await rpc.close();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { EvmChain, type EvmChainConfig } from '@merces/chain-evm';
import { SOLANA_GENESIS, SolanaChain, type SolanaChainConfig } from '@merces/chain-solana';
import { evmRpc, fakeRpc, solanaRpc } from './fake-rpc.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const solCfg = (over: Partial<SolanaChainConfig> = {}): SolanaChainConfig => ({
  chain: 'solana', cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', programs: { series: '11111111111111111111111111111111' },
  idlDir: null, generatedDir: null, stablecoins: {}, startSlot: 0, keeperPublicKey: null, allowlistManagerPublicKey: null, ...over,
});
const evmCfg = (over: Partial<EvmChainConfig> = {}): EvmChainConfig => ({
  chain: 'monad', network: 'monad-testnet', chainId: 10143, rpcUrl: 'https://testnet-rpc.monad.xyz', contracts: { Series: '0x' + '22'.repeat(20) },
  abiDir: null, generatedDir: null, stablecoins: {}, startBlock: 0, finalityTag: 'finalized', keeperAddress: null, allowlistManagerAddress: null, ...over,
});

describe('Solana mainnet guard', () => {
  it('accepts only devnet, testnet and loopback localnet at construction, whatever the case', () => {
    expect(() => new SolanaChain(solCfg({ cluster: 'Mainnet-Beta' as never }))).toThrow(/never touch mainnet/);
    expect(() => new SolanaChain(solCfg({ cluster: 'mainnet' as never }))).toThrow(/never touch mainnet/);
    expect(() => new SolanaChain(solCfg({ cluster: 'localnet', rpcUrl: 'https://solana-rpc.publicnode.com' }))).toThrow(/loopback/);
    expect(() => new SolanaChain(solCfg({ rpcUrl: 'https://api.mainnet-beta.solana.com' }))).toThrow(/mainnet/);
    expect(() => new SolanaChain(solCfg({ cluster: 'Devnet' as never }))).not.toThrow();
  });

  it('refuses an RPC whose genesis hash is mainnet-beta even when the URL and cluster look like devnet', async () => {
    const rpc = await fakeRpc(solanaRpc(SOLANA_GENESIS.mainnetBeta));
    closers.push(rpc.close);
    const chain = new SolanaChain(solCfg({ rpcUrl: rpc.url }));
    const h = await chain.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/refusing: RPC is Solana mainnet-beta/);
    await expect(chain.now()).rejects.toThrow(/mainnet-beta/);
    expect(rpc.calls).not.toContain('getSlot');
  });

  it("refuses a genesis hash that is not the configured cluster's, and accepts the right one", async () => {
    const rpc = await fakeRpc(solanaRpc(SOLANA_GENESIS.devnet));
    closers.push(rpc.close);
    expect((await new SolanaChain(solCfg({ cluster: 'testnet', rpcUrl: rpc.url })).health()).detail).toMatch(/not testnet's/);
    const ok = await new SolanaChain(solCfg({ rpcUrl: rpc.url })).health();
    expect(ok.ok).toBe(true);
    const unknown = await fakeRpc(solanaRpc('11111111111111111111111111111111'));
    closers.push(unknown.close);
    expect((await new SolanaChain(solCfg({ rpcUrl: unknown.url })).health()).ok).toBe(false);
    expect((await new SolanaChain(solCfg({ cluster: 'localnet', rpcUrl: unknown.url })).health()).ok).toBe(true);
  });
});

describe('EVM mainnet guard', () => {
  it('allows only allow-listed testnet chain ids', () => {
    for (const id of [1, 143, 59144, 324, 100, 534352, 81457, 42170]) expect(() => new EvmChain(evmCfg({ chainId: id }))).toThrow(/allow-listed EVM testnets/);
    expect(() => new EvmChain(evmCfg({ chainId: 10143 }))).not.toThrow();
    expect(() => new EvmChain(evmCfg({ chainId: 11155111, network: 'sepolia', rpcUrl: 'https://rpc.sepolia.org' }))).not.toThrow();
    expect(() => new EvmChain(evmCfg({ network: 'monad-mainnet' }))).toThrow(/mainnet/);
  });

  it('refuses an RPC that serves another chain id than the allow-listed one configured', async () => {
    const rpc = await fakeRpc(evmRpc(59144));
    closers.push(rpc.close);
    const chain = new EvmChain(evmCfg({ rpcUrl: rpc.url }));
    const h = await chain.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/refusing: rpc chainId 59144/);
    await expect(chain.getBalance('0x' + '11'.repeat(20), 'USDC')).resolves.toBe('0'); // no token configured: no RPC use
    await expect(chain.now()).rejects.toThrow(/refusing/);
  });
});

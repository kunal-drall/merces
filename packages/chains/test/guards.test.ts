import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvmChain, type EvmChainConfig } from '@merces/chain-evm';
import { SOLANA_GENESIS, SolanaChain, type SolanaChainConfig } from '@merces/chain-solana';
import { evmRpc, fakeRpc, solanaRpc,SOL_PROGRAMS,EVM_CONTRACTS } from './fake-rpc.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

const solCfg = (over: Partial<SolanaChainConfig> = {}): SolanaChainConfig => ({
  chain: 'solana', cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', programs:SOL_PROGRAMS,
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

describe('complete deployment health',()=>{
 it('reuses successful bytecode presence for five minutes but checks registry state on every probe',async()=>{
  const handlers=evmRpc(10143),rpc=await fakeRpc(handlers);closers.push(rpc.close);
  const chain=new EvmChain(evmCfg({rpcUrl:rpc.url,contracts:EVM_CONTRACTS}));
  let clock=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>clock);
  expect((await chain.health()).ok).toBe(true);
  const codeReads=rpc.calls.filter(m=>m==='eth_getCode').length;
  expect(codeReads).toBe(Object.keys(EVM_CONTRACTS).length);
  const reads=rpc.calls.filter(m=>m==='eth_call').length;
  expect((await chain.health()).ok).toBe(true);
  expect(rpc.calls.filter(m=>m==='eth_getCode')).toHaveLength(codeReads);
  expect(rpc.calls.filter(m=>m==='eth_call').length).toBeGreaterThan(reads);
  // A changed signing domain must fail even while code presence is cached.
  const originalCall=handlers.eth_call!;handlers.eth_call=evmRpc(11155111).eth_call!;
  expect((await chain.health()).detail).toContain('signing domain differs');
  handlers.eth_call=originalCall;
  clock+=5*60_000;handlers.eth_getCode=()=> '0x';
  expect((await chain.health()).detail).toContain('contracts missing');
  // A missing deployment is immediately retried rather than caching failure.
  handlers.eth_getCode=()=> '0x6001';
  expect((await chain.health()).ok).toBe(true);
  expect(rpc.calls.filter(m=>m==='eth_getCode')).toHaveLength(codeReads*3);
 });
 it('refuses a partial EVM manifest before enabling the adapter',async()=>{
  const rpc=await fakeRpc(evmRpc(10143));closers.push(rpc.close);
  const health=await new EvmChain(evmCfg({rpcUrl:rpc.url,contracts:{MercesRegistry:'0x'+'14'.repeat(20)}})).health();
  expect(health.ok).toBe(false);expect(health.detail).toContain('missing deployment module');
 });
 it('uses the normalized Solana cluster for the pinned registry domain',async()=>{
  const rpc=await fakeRpc(solanaRpc(SOLANA_GENESIS.devnet));closers.push(rpc.close);
  expect((await new SolanaChain(solCfg({rpcUrl:rpc.url,cluster:'Devnet' as never})).health()).ok).toBe(true);
 });
});

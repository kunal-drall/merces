import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal JSON-RPC server on loopback: `handlers[method](params)` returns the result. */
export async function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const one = (r: { id: unknown; method: string; params?: unknown[] }) => {
        calls.push(r.method);
        const h = handlers[r.method];
        return h ? { jsonrpc: '2.0', id: r.id, result: h(r.params ?? []) } : { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `no ${r.method}` } };
      };
      const parsed = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function solanaRpc(genesisHash: string): Record<string, (params: unknown[]) => unknown> {
  return {
    getGenesisHash: () => genesisHash,
    getSlot: () => 42,
    getVersion: () => ({ 'solana-core': '2.1.0', 'feature-set': 1 }),
    getAccountInfo: () => ({ context: { slot: 42 }, value: { data: ['', 'base64'], executable: true, lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', rentEpoch: 0, space: 0 } }),
  };
}

export function evmRpc(chainId: number): Record<string, (params: unknown[]) => unknown> {
  const h32 = (b: string) => '0x' + b.repeat(32);
  return {
    eth_chainId: () => '0x' + chainId.toString(16),
    eth_getCode: () => '0x6001',
    eth_getBlockByNumber: () => ({
      number: '0x10', hash: h32('ab'), parentHash: h32('cd'), timestamp: '0x6900', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0',
      miner: '0x' + '00'.repeat(20), extraData: '0x', logsBloom: '0x' + '00'.repeat(256), transactionsRoot: h32('00'), stateRoot: h32('00'), receiptsRoot: h32('00'),
      sha3Uncles: h32('00'), size: '0x1', totalDifficulty: '0x0', transactions: [], uncles: [],
    }),
  };
}

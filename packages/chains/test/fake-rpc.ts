import {PublicKey} from '@solana/web3.js';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {signingDomain} from '@merces/domain';
import {idlOf,encodeType,type IdlType} from '../../chain-solana/src/codec.ts';
import {pda} from '../../chain-solana/src/accounts.ts';
import {abiOf} from '../../chain-evm/src/abi.ts';
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

export const SOL_PROGRAMS=Object.fromEntries((['registry','protocol','hook'] as const).map((m)=>[`merces_${m}`,idlOf(m).address]));
function zeroType(type:IdlType):unknown {const idl=idlOf('registry');if(typeof type==='string')return type==='pubkey'?PublicKey.default.toBase58():type==='bool'?false:type==='string'?'':0;if('option'in type)return null;if('vec'in type)return [];if('array'in type)return type.array[0]==='u8'?Buffer.alloc(type.array[1]):Array.from({length:type.array[1]},()=>zeroType(type.array[0]));const t=idl.types.find((d)=>d.name===type.defined.name)!;return Object.fromEntries(t.type.fields!.map((f)=>[f.name,zeroType(f.type)]));}
export function solanaRpc(genesisHash: string): Record<string, (params: unknown[]) => unknown> {
  const registry=SOL_PROGRAMS.merces_registry!,tag=genesisHash==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'?103:genesisHash==='4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'?102:104;
  const value={...zeroType({defined:{name:'ProtocolConfig'}}) as object,domain:signingDomain('solana',tag,registry).domain};
  const data=Buffer.concat([Buffer.from(idlOf('registry').accounts.find((a)=>a.name==='ProtocolConfig')!.discriminator),encodeType(idlOf('registry'),{defined:{name:'ProtocolConfig'}},value)]).toString('base64');
  return {
    getBlockTime:()=>1700000000,
    getGenesisHash: () => genesisHash,
    getSlot: () => 42,
    getVersion: () => ({ 'solana-core': '2.1.0', 'feature-set': 1 }),
    getAccountInfo: ([address]) => ({ context: { slot: 42 }, value:address===pda(registry,'config')?{data:[data,'base64'],executable:false,lamports:1,owner:registry,rentEpoch:0,space:Buffer.from(data,'base64').length}:{ data: ['', 'base64'], executable: true, lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', rentEpoch: 0, space: 0 } }),
  };
}

export const EVM_CONTRACTS=Object.fromEntries(['Registry','Auction','Treasury','Income','Vault','Window','Router','FxAccumulator'].map((m,i)=>[`Merces${m}`,'0x'+(i+20).toString(16).repeat(20)]));
export function evmRpc(chainId: number): Record<string, (params: unknown[]) => unknown> {
  const h32 = (b: string) => '0x' + b.repeat(32);
  return {
    eth_call: ([raw])=>{const call=raw as {to:string;data:`0x${string}`},abi=abiOf('Registry'),decoded=decodeFunctionData({abi,data:call.data}),result=decoded.functionName==='domain'?signingDomain('evm',chainId,call.to).domain:decoded.functionName==='getProtocolContracts'?{auction:EVM_CONTRACTS.MercesAuction,treasury:EVM_CONTRACTS.MercesTreasury,income:EVM_CONTRACTS.MercesIncome,vault:EVM_CONTRACTS.MercesVault,window:EVM_CONTRACTS.MercesWindow,tokenFactory:'0x'+'11'.repeat(20)}:decoded.functionName==='getFlags'?{newRaisesPaused:false,windowsEnabled:false,tier4Enabled:false}:'0x'+'11'.repeat(20);return encodeFunctionResult({abi,functionName:decoded.functionName,result});},
    eth_chainId: () => '0x' + chainId.toString(16),
    eth_getCode: () => '0x6001',
    eth_getBlockByNumber: () => ({
      number: '0x10', hash: h32('ab'), parentHash: h32('cd'), timestamp: '0x6900', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0',
      miner: '0x' + '00'.repeat(20), extraData: '0x', logsBloom: '0x' + '00'.repeat(256), transactionsRoot: h32('00'), stateRoot: h32('00'), receiptsRoot: h32('00'),
      sha3Uncles: h32('00'), size: '0x1', totalDifficulty: '0x0', transactions: [], uncles: [],
    }),
  };
}

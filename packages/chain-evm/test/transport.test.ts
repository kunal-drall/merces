import {describe,expect,it,vi} from 'vitest';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {encodeErrorResult,encodeEventTopics,encodeAbiParameters,type PublicClient} from 'viem';
import type {SignedTx,UnsignedTx} from '@merces/domain';
import {EvmTransport} from '../src/transport.ts';
import {abiOf,evmError} from '../src/abi.ts';
import type {EvmChainConfig} from '../src/config.ts';
const address='0x'+'12'.repeat(20),hash='0x'+'ab'.repeat(32);
const config:EvmChainConfig={chain:'monad',network:'local',chainId:31337,rpcUrl:'http://localhost:8545',contracts:{MercesRegistry:address},abiDir:null,generatedDir:null,stablecoins:{},startBlock:0,finalityTag:'finalized',keeperAddress:null,allowlistManagerAddress:null};
async function signed():Promise<SignedTx>{const account=privateKeyToAccount(generatePrivateKey()),p={to:address as `0x${string}`,data:'0x1234' as const,value:7n,chainId:31337};const serialized=await account.signTransaction({...p,gas:21000n,nonce:0,maxFeePerGas:2n,maxPriorityFeePerGas:1n,type:'eip1559'});const tx:UnsignedTx={chain:'monad',family:'evm',signer:account.address.toLowerCase(),command:{kind:'crankStatus',seriesId:'monad:1'},payload:JSON.stringify({...p,value:'7'}),encoding:'evm-json',summary:'test',expiresAt:null};return {tx,signatures:{[tx.signer]:serialized}};}
function setup(){const client={sendRawTransaction:vi.fn(async()=>hash),waitForTransactionReceipt:vi.fn(async()=>({status:'success',blockNumber:7n,blockHash:hash})),getBlock:vi.fn(async()=>({number:7n,timestamp:1780000000n,hash})),readContract:vi.fn(async()=>0n)},verify=vi.fn(async()=>{}),transport=new EvmTransport(config,client as unknown as PublicClient,verify);return {client,verify,transport};}
describe('EVM signed transaction boundary',()=>{
 it('verifies the signer and exact call before broadcast, then pins the finalized receipt block',async()=>{const {transport,client,verify}=setup(),s=await signed();expect(await transport.send(s)).toMatchObject({txId:hash,blockRef:'7',blockTime:1780000000});expect(client.sendRawTransaction).toHaveBeenCalledOnce();expect(verify).toHaveBeenCalled();});
 it.each(['to','data','value','chainId'])('rejects changed %s before sending',async(field)=>{const {transport,client}=setup(),s=await signed(),p=JSON.parse(s.tx.payload);p[field]=field==='chainId'?1:field==='value'?'8':field==='data'?'0xabcd':'0x'+'13'.repeat(20);await expect(transport.send({...s,tx:{...s.tx,payload:JSON.stringify(p)}})).rejects.toMatchObject({code:'Unauthorized'});expect(client.sendRawTransaction).not.toHaveBeenCalled();});
 it('rejects another signer and changed finality blocks',async()=>{const {transport,client}=setup(),s=await signed();await expect(transport.send({...s,tx:{...s.tx,signer:address},signatures:{[address]:Object.values(s.signatures)[0]!}})).rejects.toMatchObject({code:'Unauthorized'});client.getBlock.mockResolvedValue({number:7n,timestamp:1780000000n,hash:'0x'+'cd'.repeat(32)});await expect(transport.send(s)).rejects.toThrow('receipt changed');});
 it('pins every snapshot read to its finalized block number and sanitizes RPC errors',async()=>{const {transport,client}=setup();const snapshot=await transport.snapshot();await snapshot.read('Registry','admin');expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({blockNumber:7n}));const e=evmError({cause:{data:encodeErrorResult({abi:abiOf('Registry'),errorName:'NotIssuer'}),message:'private=123'}});expect(e.code).toBe('Unauthorized');expect(JSON.stringify(e)).not.toContain('123');});
});

describe('EVM public RPC event pagination',()=>{
 it('keeps inclusive ranges within 100 blocks and resumes a failed page without losing or duplicating logs',async()=>{
  const modules=['Registry','Auction','Income','Vault','Treasury','Window','Router','FxAccumulator'];
  const contracts=Object.fromEntries(modules.map((m,i)=>[`Merces${m}`,'0x'+(i+1).toString(16).padStart(40,'0')]));
  const ranges:bigint[][]=[];let fail=true;
  const getLogs=vi.fn(async({fromBlock,toBlock}:{fromBlock:bigint;toBlock:bigint})=>{
   ranges.push([fromBlock,toBlock]);expect(toBlock-fromBlock).toBeLessThan(100n);
   if(fromBlock===100n&&fail){fail=false;throw new Error('temporary RPC error');}
   return [99n,100n,200n].filter(b=>b>=fromBlock&&b<=toBlock).map(b=>({address:contracts.MercesRegistry,data:encodeAbiParameters([{type:'address'}],[address as `0x${string}`]),topics:encodeEventTopics({abi:abiOf('Registry'),eventName:'IssuerRegistered',args:{issuer:address}}),blockNumber:b,logIndex:0,transactionIndex:0,transactionHash:hash,removed:false}));
  });
  const transport=new EvmTransport({...config,contracts},{getLogs,getBlock:async()=>({timestamp:1780000000n})} as unknown as PublicClient,async()=>{});
  await expect(transport.history(200n)).rejects.toThrow('temporary RPC error');
  const events=await transport.history(200n);
  expect(events.map(e=>e.blockNumber)).toEqual([99n,100n,200n]);
  expect(ranges).toEqual([[0n,99n],[100n,199n],[200n,200n],[100n,199n],[200n,200n]]);
  await transport.history(200n);expect(getLogs).toHaveBeenCalledTimes(5);
 });
});

describe('in-flight finalized read coalescing',()=>{
 it('shares concurrent heads but reads a fresh head after completion',async()=>{
  const {transport,client}=setup();await Promise.all([transport.head(),transport.head(),transport.head()]);expect(client.getBlock).toHaveBeenCalledTimes(1);await transport.head();expect(client.getBlock).toHaveBeenCalledTimes(2);
 });
 it('shares only identical pinned reads and never caches their completed result',async()=>{
  const {transport,client}=setup();await Promise.all([transport.read('Registry','admin',[],7n),transport.read('Registry','admin',[],7n),transport.read('Registry','admin',[],8n),transport.read('Registry','feeCollector',[],7n)]);expect(client.readContract).toHaveBeenCalledTimes(3);await transport.read('Registry','admin',[],7n);expect(client.readContract).toHaveBeenCalledTimes(4);
  await Promise.all([transport.read('Registry','admin'),transport.read('Registry','admin')]);expect(client.readContract).toHaveBeenCalledTimes(6);
 });
 it('retries a failed head and pinned read on the next request',async()=>{
  const {transport,client}=setup();client.getBlock.mockRejectedValueOnce(new Error('offline'));await expect(transport.head()).rejects.toThrow('offline');await transport.head();expect(client.getBlock).toHaveBeenCalledTimes(2);
  client.readContract.mockRejectedValueOnce(new Error('offline'));await expect(transport.read('Registry','admin',[],7n)).rejects.toThrow();await transport.read('Registry','admin',[],7n);expect(client.readContract).toHaveBeenCalledTimes(2);
 });
});

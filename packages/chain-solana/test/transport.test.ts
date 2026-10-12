import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {PublicKey,Transaction,SystemProgram,Connection} from '@solana/web3.js';
import type {UnsignedTx,SignedTx} from '@merces/domain';
import {SolanaTransport,solanaError} from '../src/transport.ts';
import {decodeAccount,decodeEvent,encodeInstruction,idlOf} from '../src/codec.ts';
import {TOKEN} from '../src/accounts.ts';
import type {SolanaChainConfig} from '../src/config.ts';
const key=(x:number)=>new PublicKey(Buffer.alloc(32,x)).toBase58();
const config:SolanaChainConfig={chain:'solana',cluster:'localnet',rpcUrl:'http://localhost:8899',programs:Object.fromEntries(['registry','protocol','hook'].map((m)=>[`merces_${m}`,idlOf(m as 'registry').address])),idlDir:null,generatedDir:null,stablecoins:{USDC:key(7)},startSlot:0,keeperPublicKey:null,allowlistManagerPublicKey:null};
function signed():SignedTx{
 const keys=generateKeyPairSync('ed25519'),wallet=new PublicKey(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32));
 const message=new Transaction({feePayer:wallet,recentBlockhash:key(8)}).add(SystemProgram.transfer({fromPubkey:wallet,toPubkey:new PublicKey(key(9)),lamports:1})).serializeMessage();
 const tx:UnsignedTx={chain:'solana',family:'solana',signer:wallet.toBase58(),command:{kind:'crankStatus',seriesId:`solana:${key(10)}`},payload:message.toString('base64'),encoding:'solana-base64',summary:'test',expiresAt:null};
 return {tx,signatures:{[tx.signer]:sign(null,message,keys.privateKey).toString('hex')}};
}
function setup(over:Record<string,unknown>={}){
 const connection={getSlot:vi.fn(async()=>10),getBlockTime:vi.fn(async()=>1780000000),isBlockhashValid:vi.fn(async()=>({value:true})),sendRawTransaction:vi.fn(async()=>key(4)),getSignatureStatuses:vi.fn(async()=>({value:[{slot:10,confirmationStatus:'finalized',err:null}]})),...over};
 const network=vi.fn(async()=>{}),transport=new SolanaTransport(config,connection as unknown as Connection,network);return {connection,network,transport};
}
describe('Solana binary and transport boundaries',()=>{
 it('decodes Ledger using the Rust repr(C) offsets, including tagged arrays and flags',()=>{
  // Stage 1 state.rs:175-265: 160 u128 bytes, 504 u64 bytes, 64 key bytes, 68 u32 bytes, 26 flags + 10 padding.
  const data=Buffer.alloc(840);Buffer.from(idlOf('protocol').accounts.find((a)=>a.name==='Ledger')!.discriminator).copy(data);
  data.writeBigUInt64LE(17n,8);data.writeBigUInt64LE(23n,8+264);new PublicKey(key(5)).toBuffer().copy(data,8+664);data.writeUInt32LE(8104,8+728);data[8+796]=5;data[8+796+3]=1;data[8+796+15]=1;
  const decoded=decodeAccount('protocol',data)!.value;expect(decoded).toMatchObject({paid_per_unit_wad:17n,units_outstanding:23n,series:key(5),first_period:8104,status:5,has_open_due_period:1});expect((decoded.year_gross_set as Buffer)[0]).toBe(1);
  expect(()=>decodeAccount('protocol',data.subarray(0,839))).toThrow('truncated');
 });
 it('matches Anchor discriminators and little-endian instruction bytes independently',()=>{
  const bytes=encodeInstruction('registry','set_contract_hash',{hash:'0x'+'ab'.repeat(32)});
  expect(bytes).toEqual(Buffer.concat([createHash('sha256').update('global:set_contract_hash').digest().subarray(0,8),Buffer.alloc(32,0xab)]));
  const event=Buffer.concat([createHash('sha256').update('event:IssuerRegistered').digest().subarray(0,8),new PublicKey(key(5)).toBuffer()]);
  expect(decodeEvent('registry',event)).toEqual({name:'IssuerRegistered',args:{wallet:key(5)}});
 });
 it('broadcasts only a matching single-wallet signature and waits for finality',async()=>{
  const {transport,connection,network}=setup(),s=signed();expect((await transport.send(s)).blockRef).toBe('10');expect(network).toHaveBeenCalledOnce();expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Buffer),{preflightCommitment:'finalized',skipPreflight:false,maxRetries:3});
 });
 it('rejects tampering, another chain, extra signatures and expired blockhashes before broadcast',async()=>{
  const {transport,connection}=setup(),s=signed();
  const message=Buffer.from(s.tx.payload,'base64');message[message.length-1]=message[message.length-1]!^1;
  await expect(transport.send({...s,tx:{...s.tx,payload:message.toString('base64')}})).rejects.toMatchObject({code:'Unauthorized'});
  await expect(transport.send({...s,tx:{...s.tx,chain:'elsewhere'}})).rejects.toMatchObject({code:'Unauthorized'});
  await expect(transport.send({...s,signatures:{...s.signatures,[key(2)]:'bad'}})).rejects.toMatchObject({code:'Unauthorized'});
  connection.isBlockhashValid.mockResolvedValue({value:false});await expect(transport.send(s)).rejects.toMatchObject({code:'TooLate'});expect(connection.sendRawTransaction).not.toHaveBeenCalled();
 });
 it('accepts exactly the two signatures required to create a reviewed Meteora account',async()=>{
  const {transport,connection}=setup();
  const pair=()=>{const k=generateKeyPairSync('ed25519');return {...k,address:new PublicKey(k.publicKey.export({format:'der',type:'spki'}).subarray(-32))};};
  const wallet=pair(),account=pair();
  const raw=new Transaction({feePayer:wallet.address,recentBlockhash:key(8)}).add(SystemProgram.createAccount({fromPubkey:wallet.address,newAccountPubkey:account.address,lamports:1,space:1,programId:new PublicKey(key(9))})).serializeMessage();
  const tx:UnsignedTx={chain:'solana',family:'solana',signer:wallet.address.toBase58(),command:{kind:'createCurveConfig',seriesId:`solana:${key(10)}`,config:account.address.toBase58(),parameters:{}},payload:raw.toString('base64'),encoding:'solana-base64',summary:'create',expiresAt:null};
  const signatures=Object.fromEntries([wallet,account].map(k=>[k.address.toBase58(),sign(null,raw,k.privateKey).toString('hex')]));
  await expect(transport.send({tx,signatures:{[tx.signer]:signatures[tx.signer]!}})).rejects.toMatchObject({code:'Unauthorized'});
  await expect(transport.send({tx:{...tx,command:{kind:'crankStatus',seriesId:`solana:${key(10)}`}},signatures})).rejects.toMatchObject({code:'Unauthorized'});
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  await expect(transport.send({tx,signatures})).resolves.toMatchObject({blockRef:'10'});
 });
 it('checks token account ownership and mint, and never leaks RPC errors or logs',async()=>{
  const data=Buffer.alloc(165);new PublicKey(key(7)).toBuffer().copy(data);data.writeBigUInt64LE(99n,64);
  const {transport}=setup({getAccountInfo:async()=>({owner:new PublicKey(TOKEN),data})});expect(await transport.tokenBalance(key(1),key(7))).toBe(99n);
  await expect(transport.tokenBalance(key(1),key(8))).rejects.toThrow('invalid token account');
  const e=solanaError({message:'secret income=123',logs:['secret income=123','Program log: AnchorError occurred. Error Code: NotIssuer.']});expect(e.code).toBe('Unauthorized');expect(JSON.stringify(e)).not.toContain('123');
 });
 it('reads signature-only finalized blocks through the matching web3 RPC decoder',async()=>{
  const seen:{method:string;params:unknown[]}[]=[];
  const connection=new Connection('http://localhost:8899',{fetch:async(_url,init)=>{
   const request=JSON.parse(String(init?.body));seen.push(request);
   const results:Record<string,unknown>={getSlot:10,getBlockTime:1780000000,getSignaturesForAddress:[{signature:key(3),slot:10,err:null,memo:null,blockTime:1780000000,confirmationStatus:'finalized'}],getBlock:{blockhash:key(8),previousBlockhash:key(9),parentSlot:9,signatures:[key(3)],blockTime:1780000000},getTransaction:{slot:10,blockTime:1780000000,meta:{err:null,fee:0,preBalances:[],postBalances:[],logMessages:[]},transaction:{signatures:[key(3)],message:{accountKeys:[],header:{numRequiredSignatures:0,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:0},recentBlockhash:key(8),instructions:[]}}}};
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}),{status:200});
  }});
  const transport=new SolanaTransport(config,connection,async()=>{});
  await expect(transport.history()).resolves.toEqual([]);
  expect(seen.find(x=>x.method==='getBlock')?.params).toEqual([10,{commitment:'finalized',transactionDetails:'signatures',rewards:false}]);
 });
 it.each([null,['Log truncated']])('fails closed on unavailable or truncated finalized logs',async(logMessages)=>{
  const {transport}=setup({getSignaturesForAddress:async()=>[{signature:key(3),slot:10,err:null}],getBlockSignatures:async()=>({signatures:[key(3)]}),getTransaction:async()=>({blockTime:1780000000,meta:{err:null,logMessages}})});
  await expect(transport.history()).rejects.toThrow('complete transaction logs');
 });
});
